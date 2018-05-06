'use strict';

// article api

const
    _ = require('lodash'),
    api = require('../api'),
    db = require('../db'),
    md = require('../md'),
    cache = require('../cache'),
    logger = require('../logger'),
    helper = require('../helper'),
    config = require('../config'),
    constants = require('../constants'),
    search = require('../search/search'),
    User = db.User,
    Article = db.Article,
    Category = db.Category,
    Text = db.Text,
    nextId = db.nextId,
    textApi = require('./textApi'),
    settingApi = require('./settingApi'),
    categoryApi = require('./categoryApi'),
    attachmentApi = require('./attachmentApi');

function indexArticle(r) {
    // process.nextTick(() => {
    //     search.engine.index({
    //         type: 'article',
    //         id: r.id,
    //         tags: r.tags,
    //         name: r.name,
    //         description: r.description,
    //         content: md.htmlToText(md.systemMarkdownToHtml(r.content)),
    //         created_at: r.publish_at,
    //         updated_at: r.updated_at,
    //         url: '/article/' + r.id,
    //         upvotes: 0
    //     });
    // });
}

function unindexArticle(r) {
    process.nextTick(() => {
        search.engine.unindex({
            id: r.id
        });
    });
}

// get recent published articles:
async function getRecentArticles(max) {
    // where publish_at < ? order by publish_at desc limit ?
    return await Article.findAll({
        where: {
            publish_at: {
                $lt: Date.now()
            }
        },
        order: 'publish_at DESC',
        limit: max
    });
}

async function getArticles(page, includeUnpublished=false) {
    let opt = includeUnpublished ? {} : {
        where: {
            publish_at: {
                $lt: Date.now()
            }
        }
    };
    page.total = await Article.count(opt);
    if (page.isEmpty) {
        return [];
    }
    opt.offset = page.offset;
    opt.limit = page.limit;
    opt.order = 'publish_at DESC';
    return await Article.findAll(opt);
}

async function getArticlesByCategory(categoryId, page) {
    let now = Date.now();
    page.total = await Article.count({
        where: {
            publish_at: {
                $lt: now
            },
            category_id: categoryId
        }
    });
    if (page.isEmpty) {
        return [];
    }
    return await Article.findAll({
        where: {
            publish_at: {
                $lt: now
            },
            category_id: categoryId
        },
        order: 'publish_at DESC',
        offset: page.offset,
        limit: page.limit
    });
}

async function getArticle(id, includeContent) {
    let article = await Article.findById(id);
    if (article === null) {
        throw api.notFound('Article');
    }
    if (includeContent) {
        let text = await Text.findById(article.content_id);
        if (text === null) {
            throw api.notFound('Text');
        }
        article.content = text.value;
    }
    return article;
}

function _toRssDate(dt) {
    return new Date(dt).toGMTString();
}

async function _getFeed(domain) {
    logger.info('generate rss...');
    let
        schema = (config.session.https ? 'https://' : 'http://'),
        url_prefix = schema + domain + '/article/',
        articles = await getRecentArticles(20),
        last_publish_at = articles.length === 0 ? 0 : articles[0].publish_at,
        website = await settingApi.getWebsiteSettings(),
        rss = [];
    rss.push('<?xml version="1.0"?>\n');
    rss.push('<rss version="2.0"><channel><title><![CDATA[');
    rss.push(website.name);
    rss.push(']]></title><link>');
    rss.push(schema);
    rss.push(domain);
    rss.push('/</link><description><![CDATA[');
    rss.push(website.description);
    rss.push(']]></description><lastBuildDate>');
    rss.push(_toRssDate(last_publish_at));
    rss.push('</lastBuildDate><generator>iTranswarp.js</generator><ttl>3600</ttl>');
    for (let i=0; i<articles.length; i++) {
        let
            article = articles[i],
            text = await Text.findById(article.content_id),
            url = url_prefix + article.id;
        rss.push('<item><title><![CDATA[');
        rss.push(article.name);
        rss.push(']]></title><link>');
        rss.push(url);
        rss.push('</link><guid>');
        rss.push(url);
        rss.push('</guid><author><![CDATA[');
        rss.push(article.user_name);
        rss.push(']]></author><pubDate>');
        rss.push(_toRssDate(article.publish_at));
        rss.push('</pubDate><description><![CDATA[');
        rss.push(md.systemMarkdownToHtml(text.value));
        rss.push(']]></description></item>');
    }
    rss.push('</channel></rss>');
    return rss.join('');
}

module.exports = {

    getRecentArticles: getRecentArticles,

    getArticlesByCategory: getArticlesByCategory,

    getArticles: getArticles,

    getArticle: getArticle,

    'GET /feed': async (ctx, next) => {
        ctx.response.redirect('/feed/articles');
    },

    'GET /feed/articles': async (ctx, next) => {
        let rss = await cache.get(constants.cache.ARTICLE_FEED, async () => {
            return await _getFeed(ctx.request.host);
        });
        ctx.response.set('Cache-Control', 'max-age: 3600');
        ctx.response.type = 'text/xml';
        ctx.response.body = rss;
    },

    'GET /api/articles/:id': async function (ctx, next) {
        /**
         * Get article.
         * 
         * @name Get Article
         * @param {string} id: Id of the article.
         * @param {string} [format]: Return html if format is 'html', default to '' (raw).
         * @return {object} Article object.
         * @error {resource:notfound} Article was not found by id.
         */
        let
            id = ctx.params.id,
            user = ctx.state.__user__,
            article = await getArticle(id, true);
        if (article.publish_at > Date.now() && (user === null || user.role > constants.role.CONTRIBUTOR)) {
            throw api.notFound('Article');
        }
        if (ctx.request.query.format === 'html') {
            article.content = helper.md2html(article.content, true);
        }
        ctx.rest(article);
    },

    'GET /api/articles': async function (ctx, next) {
        /**
         * Get articles by page.
         * 
         * @name Get Articles
         * @param {number} [page=1]: The page number, starts from 1.
         * @return {object} Article objects and page information.
         */
        let
            user = ctx.state.__user__,
            includeUnpublished = (user !== null) && (user.role <= constants.role.EDITOR),
            page = helper.getPage(ctx.request),
            articles = await getArticles(page, includeUnpublished);
        ctx.rest({
            page: page,
            articles: articles
        });
    },

    'POST /api/articles': async (ctx, next) => {
        /**
         * Create a new article.
         * 
         * @name Create Article
         * @param {string} category_id: Id of the category that article belongs to.
         * @param {string} name: Name of the article.
         * @param {string} description: Description of the article.
         * @param {string} content: Content of the article.
         * @param {string} [tags]: Tags of the article, seperated by ','.
         * @param {string} [publish_at]: Publish time of the article with format 'yyyy-MM-dd HH:mm:ss', default to current time.
         * @param {image} [image]: Base64 encoded image to upload as cover image.
         * @return {object} The created article object.
         * @error {parameter:invalid} If some parameter is invalid.
         * @error {permission:denied} If current user has no permission.
         */
        ctx.checkPermission(constants.role.EDITOR);
        ctx.validate('createArticle');
        let
            user = ctx.state.__user__,
            article_id = nextId(),
            content_id = nextId(),
            data = ctx.request.body;
        // check category id:
        await categoryApi.getCategory(data.category_id);
        // create image:
        data.image = "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…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"


        let attachment = await attachmentApi.createAttachment(
            user.id,
            data.name.trim(),
            data.description.trim(),
            new Buffer(data.image, 'base64'),
            null,
            true);
        // create text:
        await textApi.createText(article_id, content_id, data.content);
        // create article:
        let article = await Article.create({
            id: article_id,
            user_id: user.id,
            user_name: user.name,
            category_id: data.category_id,
            cover_id: attachment.id,
            content_id: content_id,
            name: data.name.trim(),
            description: data.description.trim(),
            tags: helper.formatTags(data.tags),
            publish_at: (data.publish_at === undefined ? Date.now() : data.publish_at)
        });
        // associate content:
        article.content = data.content;
        // index:
        indexArticle(article);
        ctx.rest(article);
    },

    'POST /api/articles/:id': async (ctx, next) => {
        /**
         * Update an exist article.
         * 
         * @name Update Article
         * @param {string} id: Id of the article.
         * @param {string} [category_id]: Id of the category that article belongs to.
         * @param {string} [name]: Name of the article.
         * @param {string} [description]: Description of the article.
         * @param {string} [content]: Content of the article.
         * @param {string} [tags]: Tags of the article, seperated by ','.
         * @param {string} [publish_at]: Publish time of the article with format 'yyyy-MM-dd HH:mm:ss'.
         * @return {object} The updated article object.
         * @error {resource:notfound} Article was not found by id.
         * @error {parameter:invalid} If some parameter is invalid.
         * @error {permission:denied} If current user has no permission.
         */
        ctx.checkPermission(constants.role.EDITOR);
        ctx.validate('updateArticle');
        let
            id = ctx.params.id,
            user = ctx.state.__user__,
            data = ctx.request.body,
            article = await getArticle(id);
        if (user.role !== constants.role.ADMIN && user.id !== article.user_id) {
            throw api.notAllowed('Permission denied.');
        }
        if (data.category_id) {
            await categoryApi.getCategory(data.category_id);
            article.category_id = data.category_id;
        }
        if (data.name) {
            article.name = data.name.trim();
        }
        if (data.description) {
            article.description = data.description.trim();
        }
        if (data.tags) {
            article.tags = helper.formatTags(data.tags);
        }
        if (data.publish_at !== undefined) {
            article.publish_at = data.publish_at;
        }
        if (data.image) {
            // check image:
            let attachment = await attachmentApi.createAttachment(
                user.id,
                article.name,
                article.description,
                new Buffer(data.image, 'base64'),
                null,
                true);
            article.cover_id = attachment.id;
        }
        if (data.content) {
            let content_id = nextId();
            await textApi.createText(article.id, content_id, data.content);
            article.content_id = content_id;
        }
        await article.save();
        // attach content:
        if (data.content) {
            article.content = data.content;
        } else {
            let text = await Text.findById(article.content_id);
            article.content = text.value;
        }
        ctx.rest(article);
    },

    'POST /api/articles/:id/delete': async (ctx, next) => {
        /**
         * Delete an article.
         * 
         * @name Delete Article
         * @param {string} id: Id of the article.
         * @return {object} Object contains deleted id.
         * @error {resource:notfound} Article not found by id.
         * @error {permission:denied} If current user has no permission.
         */
        ctx.checkPermission(constants.role.EDITOR);
        let
            id = ctx.params.id,
            user = ctx.state.__user__,
            article = await getArticle(id);
        if ((user.role > constants.role.ADMIN) && (user.id !== article.user_id)) {
            throw api.notAllowed('Permission denied.');
        }
        await article.destroy();
        await Text.destroy({
            where: {
                'ref_id': id
            }
        });
        ctx.rest({ id: id });
    }
};

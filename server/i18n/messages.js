const { DEFAULT_LOCALE, isSupportedLocale } = require('./config');

const messages = {
  zh: {
    language: {
      zh: '中文',
      en: 'English',
      switchLabel: '切换语言'
    },
    navigation: {
      home: '首页',
      archive: '归档',
      tags: '标签',
      search: '搜索',
      about: '关于',
      rss: 'RSS',
      admin: '管理',
      siteName: '我的博客',
      ariaLabel: '主导航',
      breadcrumb: '面包屑'
    },
    home: {
      latestArticles: '最新文章',
      noArticlesUser: '还没有文章，',
      publishNow: '立即发布',
      noArticlesGuest: '敬请期待！'
    },
    article: {
      published: '发布于 {date}',
      updated: '更新于 {date}',
      categories: '分类：',
      tags: '标签：',
      readingTime: '阅读时长约 {minutes} 分钟',
      backHome: '返回首页',
      related: '相关文章',
      navigationAria: '相邻文章',
      audioFallback: '无法播放时打开音频文件'
    },
    categories: {
      title: '文章分类',
      all: '全部分类',
      uncategorized: '未分类',
      empty: '该分类下暂无文章',
      backToOverview: '← 查看全部分类'
    },
    comments: {
      title: '评论',
      privacyNotice: '评论提交后需要管理员审核；审核通过后会公开正文和你当前 Google 展示名称。',
      emailNeverShared: '本站不会公开你的邮箱或头像。',
      empty: '还没有审核通过的评论。',
      commentingAs: '正在以 {name} 的身份评论。',
      logout: '退出账号',
      contentLabel: '评论内容',
      contentHelp: '纯文本，去除首尾空白后最多 1000 个字符。',
      submit: '提交评论',
      loginPrompt: '使用 Google 登录后评论'
    },
    notFound: {
      title: '404 - 页面未找到',
      message: '页面未找到',
      backHome: '返回首页'
    },
    pagination: {
      prev: '上一页',
      next: '下一页',
      page: '第 {page} 页',
      ariaLabel: '文章分页'
    },
    search: {
      title: '搜索',
      heading: '搜索文章',
      keyword: '关键词',
      button: '搜索',
      resultsCount: '“{query}”共有 {count} 条结果。',
      empty: '没有找到相关文章。'
    },
    tags: {
      title: '所有标签',
      empty: '暂无标签',
      tagTitle: '标签: {tag}',
      emptyForTag: '该标签下暂无文章',
      viewAll: '← 查看所有标签'
    },
    archive: {
      title: '文章归档',
      empty: '暂无归档内容',
      year: '{year} 年'
    },
    about: {
      title: '关于',
      heading: '关于我',
      fallback: '欢迎来到这个极简博客。'
    },
    footer: {
      poweredBy: '由 Gchigoo 极简博客驱动'
    }
  },
  en: {
    language: {
      zh: '中文',
      en: 'English',
      switchLabel: 'Switch language'
    },
    navigation: {
      home: 'Home',
      archive: 'Archive',
      tags: 'Tags',
      search: 'Search',
      about: 'About',
      rss: 'RSS',
      admin: 'Admin',
      siteName: 'My Blog',
      ariaLabel: 'Main navigation',
      breadcrumb: 'Breadcrumb'
    },
    home: {
      latestArticles: 'Latest Articles',
      noArticlesUser: 'No articles yet, ',
      publishNow: 'Publish Now',
      noArticlesGuest: 'stay tuned!'
    },
    article: {
      published: 'Published {date}',
      updated: 'Updated {date}',
      categories: 'Categories: ',
      tags: 'Tags: ',
      readingTime: 'About {minutes} min read',
      backHome: 'Back to Home',
      related: 'Related Articles',
      navigationAria: 'Adjacent articles',
      audioFallback: 'Open audio file if playback fails'
    },
    categories: {
      title: 'Categories',
      all: 'All Categories',
      uncategorized: 'Uncategorized',
      empty: 'No articles in this category',
      backToOverview: '← View all categories'
    },
    comments: {
      title: 'Comments',
      privacyNotice: 'Comments are moderated; approved comments show your text and current Google display name.',
      emailNeverShared: 'Your email and avatar are never published.',
      empty: 'No approved comments yet.',
      commentingAs: 'Commenting as {name}.',
      logout: 'Sign Out',
      contentLabel: 'Comment',
      contentHelp: 'Plain text, up to 1000 characters after trimming.',
      submit: 'Submit Comment',
      loginPrompt: 'Sign in with Google to comment'
    },
    notFound: {
      title: '404 - Page Not Found',
      message: 'Page Not Found',
      backHome: 'Back to Home'
    },
    pagination: {
      prev: 'Previous',
      next: 'Next',
      page: 'Page {page}',
      ariaLabel: 'Article pagination'
    },
    search: {
      title: 'Search',
      heading: 'Search Articles',
      keyword: 'Keyword',
      button: 'Search',
      resultsCount: '{count} results for “{query}”.',
      empty: 'No articles found.'
    },
    tags: {
      title: 'All Tags',
      empty: 'No tags yet',
      tagTitle: 'Tag: {tag}',
      emptyForTag: 'No articles under this tag',
      viewAll: '← View All Tags'
    },
    archive: {
      title: 'Archive',
      empty: 'Nothing archived yet',
      year: 'Year {year}'
    },
    about: {
      title: 'About',
      heading: 'About Me',
      fallback: 'Welcome to this minimalist blog.'
    },
    footer: {
      poweredBy: 'Powered by Gchigoo Minimalist Blog'
    }
  }
};

function deepFreeze(value) {
  if (typeof value !== 'object' || value === null) return value;
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze(value[key]);
  }
  return Object.freeze(value);
}

deepFreeze(messages);

function collectKeyPaths(catalog, prefix = '', result = []) {
  for (const key of Object.keys(catalog)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    const value = catalog[key];
    if (typeof value === 'string') {
      result.push(path);
    } else if (typeof value === 'object' && value !== null) {
      collectKeyPaths(value, path, result);
    }
  }
  return result;
}

function lookupMessage(catalog, key) {
  let current = catalog;
  for (const part of key.split('.')) {
    if (typeof current !== 'object' || current === null
      || !Object.prototype.hasOwnProperty.call(current, part)) {
      return undefined;
    }
    current = current[part];
  }
  return typeof current === 'string' ? current : undefined;
}

function interpolate(template, variables) {
  if (!variables || typeof variables !== 'object') return template;
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (placeholder, name) => (
    Object.prototype.hasOwnProperty.call(variables, name)
      ? String(variables[name])
      : placeholder
  ));
}

function createTranslator(locale) {
  if (!isSupportedLocale(locale)) {
    throw new Error(`unsupported locale: ${locale}`);
  }
  const catalog = messages[locale];
  const throwOnMissing = process.env.NODE_ENV !== 'production';
  return function translate(key, variables) {
    const template = lookupMessage(catalog, key);
    if (template === undefined) {
      if (throwOnMissing) {
        throw new Error(`missing message: ${locale}.${key}`);
      }
      return key;
    }
    return interpolate(template, variables);
  };
}

module.exports = {
  messages,
  DEFAULT_LOCALE,
  collectKeyPaths,
  createTranslator
};

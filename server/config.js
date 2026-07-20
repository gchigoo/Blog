const { parseCommentsConfig } = require('./comments/config');
const { parseAnalyticsConfig } = require('./analytics/config');

function createBaseConfig(env) {
  return {
  port: env.PORT || 3000,
  jwtSecret: env.JWT_SECRET || 'change-this-secret-in-production-' + Math.random(),
  jwtExpire: '7d',
  uploadDir: 'uploads/temp',
  imagesDir: 'public/images',
  audioDir: 'public/audio',
  articlesDir: 'articles',
  imageQuality: 80,
  pageSize: 20,
  comments: parseCommentsConfig(env)
  };
}

const config = createBaseConfig(process.env);

config.loadRuntimeConfig = (env = process.env) => Object.freeze({
  ...createBaseConfig(env),
  analytics: parseAnalyticsConfig(env)
});

module.exports = config;

module.exports = {
  port: process.env.PORT || 3000,
  jwtSecret: process.env.JWT_SECRET || 'change-this-secret-in-production-' + Math.random(),
  jwtExpire: '7d',
  analyticsHmacSecret: process.env.ANALYTICS_HMAC_SECRET || '',
  uploadDir: 'uploads/temp',
  imagesDir: 'public/images',
  articlesDir: 'articles',
  imageQuality: 80,
  pageSize: 20
};

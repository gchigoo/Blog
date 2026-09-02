// PM2 配置文件
module.exports = {
  apps: [{
    name: 'blog',
    script: './server/index.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    kill_timeout: 10000,
    listen_timeout: 10000,
    wait_ready: true,
    time: true,
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true
  }]
};

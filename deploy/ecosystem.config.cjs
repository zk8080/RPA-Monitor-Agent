/**
 * PM2 进程配置
 * 用法（仓库根目录）：
 *   pm2 start deploy/ecosystem.config.cjs
 *   pm2 logs rpa-monitor-agent
 *   pm2 restart rpa-monitor-agent
 */
const path = require('path');

const root = path.resolve(__dirname, '..');

module.exports = {
  apps: [
    {
      name: 'rpa-monitor-agent',
      cwd: root,
      script: 'monitor/service.js',
      interpreter: 'node',
      instances: 1,
      autorestart: true,
      max_restarts: 20,
      min_uptime: '10s',
      watch: false,
      // 与 service 内部 poll 互补：进程挂了由 PM2 拉起
      env: {
        NODE_ENV: 'production',
        // HEALTH_PORT: '8787',
        // DATA_DIR: path.join(root, 'data'),
      },
      error_file: path.join(root, 'data', 'logs', 'pm2-error.log'),
      out_file: path.join(root, 'data', 'logs', 'pm2-out.log'),
      merge_logs: true,
      time: true,
    },
  ],
};

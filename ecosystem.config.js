module.exports = {
  apps: [{
    script: 'Sky.js',
    watch: true,
    ignore_watch: ["node_modules",
      "storage", "public", ".git", "backup_data", "tmp"],
  },],

  deploy: {
    production: {
      user: 'SSH_USERNAME',
      host: 'SSH_HOSTMACHINE',
      ref: 'origin/master',
      repo: 'GIT_REPOSITORY',
      path: 'DESTINATION_PATH',
      'pre-deploy-local': '',
      'post-deploy': 'npm install && pm2 reload ecosystem.config.js --env production',
      'pre-setup': ''
    }
  }
};

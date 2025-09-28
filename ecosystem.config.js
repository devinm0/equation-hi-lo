module.exports = {
  apps: [
    {
      name: "equation-hi-lo",
      script: "server.ts",
      interpreter: "tsx",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "500M",
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};
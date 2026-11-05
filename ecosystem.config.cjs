module.exports = {
  apps: [
    {
      name: "seola-bot",
      script: "src/index.ts",
      interpreter: "node",
      interpreter_args: "--experimental-strip-types",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "1500M",
      kill_timeout: 5000,
      listen_timeout: 8000,
      env: {
        NODE_ENV: "production",
        AUTO_KILL_EXISTING: "true",
      },
    },
  ],
};

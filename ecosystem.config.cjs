module.exports = {
  apps: [
    {
      name: "seola-bot",
      script: "src/index.ts",
      interpreter: "node",
      interpreter_args: "--experimental-strip-types",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "2500M",
      kill_timeout: 5000,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};

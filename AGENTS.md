# Project workflow

The user authorizes automatic publication of completed changes in this project.
After relevant checks pass, commit the task changes, push to origin/main, and
ensure the Cloudflare production deployment completes. Do not ask for renewed
publication approval unless a tool permission requires it or the user changes
this instruction. Verify the production response after deployment and report
any failure accurately. Never include unrelated files or secrets in commits.

Application: cloudflare/
Production: https://controle-adega.cauealves382.workers.dev
Validation: npm.cmd test and npm.cmd run check in cloudflare/.
Deployment: use the configured GitHub workflow when available; otherwise run
npm.cmd run deploy in cloudflare/ with the configured Cloudflare account.

# 念念智股部署说明

## Railway

将本目录作为 Railway 服务根目录，构建命令为 `npm run build`，启动命令为 `npm start`。`railway.toml` 已包含这两个设置与 `/api/health` 健康检查。

生产变量只在 Railway 变量页面填写，不进入 Git、网站包或 APK：

- `NODE_ENV=production`
- `FMP_API_KEY` 或 `FINNHUB_API_KEY`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

账号与云同步使用 Supabase Auth。匿名公钥只会由 `/api/auth/config` 提供给网页；`SUPABASE_SERVICE_ROLE_KEY` 只能保留在 Railway，绝不能写入网页、APK、Git 或日志。

在 Supabase Dashboard 完成两项配置后，用户就可以用 QQ 邮箱注册并同步：

1. Authentication → Sign In / Providers：启用邮箱/密码登录；Authentication → URL Configuration：将 Site URL 填为 `https://stocks.cauai.fun`，并添加 `https://stocks.cauai.fun/*` 到 Redirect URLs。
2. Authentication → Emails → SMTP Settings：启用自定义 SMTP，填写 `smtp.qq.com`、端口 `465`、你的 QQ 邮箱、QQ 邮箱生成的 SMTP 授权码、发件人邮箱（同一个 QQ 邮箱）和发件人名称“念念智股”。QQ SMTP 授权码不是 QQ 登录密码，不要发送给任何人或写进 Railway。
3. Authentication → Emails → Templates → Confirm signup：邮件正文必须使用 `{{ .Token }}`，以便注册用户输入 Supabase 实际生成的 6～8 位验证码，而非点击验证链接。

生产模式没有 Upstash 时，`/api/market/research` 会返回 `service_not_configured`，避免无缓存、无限流的误上线。当前候选不使用 Yahoo Finance 回退。

## Cloudflare

在 `cauai.fun` 的 DNS 中为 `stocks` 添加 CNAME，目标使用 Railway 给出的服务域名；等待 Railway 的自定义域名页面确认 HTTPS 已签发后，再把 `https://stocks.cauai.fun` 作为正式入口。

## Android

Android 外壳必须只配置正式地址 `https://stocks.cauai.fun`。生成签名 APK 前还需要：Firebase 项目与 `google-services.json`、支付回跳配置、仓库外的发布签名密钥，以及正式域名的实机登录、同步、推送与断网验证。

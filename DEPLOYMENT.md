# 念念智股部署说明

## Railway

将本目录作为 Railway 服务根目录，构建命令为 `npm run build`，启动命令为 `npm start`。`railway.toml` 已包含这两个设置与 `/api/health` 健康检查。

生产变量只在 Railway 变量页面填写，不进入 Git、网站包或 APK：

- `NODE_ENV=production`
- `FMP_API_KEY` 或 `FINNHUB_API_KEY`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- 后续账号、订阅、推送接入时再添加 Clerk、Convex、Dodo、Firebase 的服务端变量。

生产模式没有 Upstash 时，`/api/market/research` 会返回 `service_not_configured`，避免无缓存、无限流的误上线。当前候选不使用 Yahoo Finance 回退。

## Cloudflare

在 `cauai.fun` 的 DNS 中为 `stocks` 添加 CNAME，目标使用 Railway 给出的服务域名；等待 Railway 的自定义域名页面确认 HTTPS 已签发后，再把 `https://stocks.cauai.fun` 作为正式入口。

## Android

Android 外壳必须只配置正式地址 `https://stocks.cauai.fun`。生成签名 APK 前还需要：Firebase 项目与 `google-services.json`、支付回跳配置、仓库外的发布签名密钥，以及正式域名的实机登录、同步、推送与断网验证。

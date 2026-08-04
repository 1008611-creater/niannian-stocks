# Convex 数据层

这里保存念念智股自己的用户数据模型，不复用 WorldMonitor 的业务表。公开查询和 mutation（写入函数）只通过当前 Clerk 身份解析 `userId`，不接受客户端传入的用户 ID。

当前表覆盖：组合、持仓、自选股、提醒规则、提醒送达记录、研究报告、套餐权益和 Android/Web 设备令牌。`workspace.ts` 中的免费层自选上限由服务端再次校验，不能靠前端限制绕过。

接入时：

1. 在 Convex 项目中部署此目录，让 Convex CLI 生成 `_generated/`。
2. 在 Convex Auth 配置中使用 Clerk 的 JWT issuer；不要把 Clerk 私钥放入网站或 APK。
3. 将 `CONVEX_URL`、`CONVEX_SITE_URL` 和服务端密钥只配置在 Railway/Convex 的服务端环境。
4. Dodo webhook 只能调用 `entitlements.setForUser` 的内部路径，不能由浏览器直接改套餐。

本地没有 Convex 配置时，股票前端继续使用本机草稿存储；接入后再把待导入包写入当前账户。

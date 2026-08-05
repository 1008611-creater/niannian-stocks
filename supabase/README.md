# 念念智股 Supabase 数据层

本目录替代早期的 Convex 方案。数据库只保存用户自己的组合、自选、提醒、报告、套餐权益和设备令牌；行情快照仍由 Railway 的同源 `/api/market/research` 服务读取 FMP/Finnhub。

## 运行边界

- 浏览器和 APK 绝不携带 `SUPABASE_SERVICE_ROLE_KEY`、数据库密码或 Dodo/Firebase/Clerk 服务端密钥。
- Railway 先验证 Clerk JWT 的 `sub`，再以该用户 ID 查询或修改 Supabase；请求中传来的任意 `userId` 都不能作为授权依据。
- 迁移不为 `anon` 或 `authenticated` 创建策略，所有表启用 RLS；只允许 Railway 的 service role 访问。
- `niannian_alert_deliveries` 的 `(alert_rule_id, period_key)` 唯一约束负责后台扫描去重。

## 恢复完成后的执行顺序

1. 在 Supabase SQL Editor 执行 `migrations/20260805210000_niannian_stocks.sql`。
2. 从 Supabase 项目设置取得项目 URL 与 service role key，只保存到 Railway 变量 `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`。
3. 在 Railway 配置 Clerk 的 JWKS issuer 和服务端密钥，再部署用户工作区接口。
4. 用同一 Clerk 账号在网页与 APK 验证：本地草稿仅首次导入，之后以云端数据为准。

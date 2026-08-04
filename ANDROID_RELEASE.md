# Android 发布

当前 Capacitor 配置固定访问 `https://stocks.cauai.fun`，不会访问本机地址。`fun.cauai.niannianstocks` 是最终 Android 包名。

开发验证：

```powershell
npm run android:debug
```

发布 APK 前必须完成：

1. `stocks.cauai.fun` 已通过 Railway 与 Cloudflare 发布 HTTPS。
2. Firebase Android 项目已登记相同包名，`google-services.json` 仅放在 `android/app/`，不提交仓库。
3. Clerk、Dodo 和 Firebase 的允许域名及深链回跳已经在各自控制台配置。
4. 在仓库外生成发布签名密钥，并通过 Android `signingConfigs.release` 引用环境变量或安全路径。

不要发布指向本机、测试 URL，或包含任何服务端密钥的 APK。

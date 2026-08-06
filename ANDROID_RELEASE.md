# Android 发布

当前 Capacitor 配置固定访问 `https://stocks.cauai.fun`，不会访问本机地址。`fun.cauai.niannianstocks` 是最终 Android 包名。当前发布版是 `1.1.0`，应用只允许正式股票站点、Supabase Auth、Dodo 与 Firebase 的必要导航域名。

登录和支付完成后统一使用 `fun.cauai.niannianstocks://auth/callback` 或 `fun.cauai.niannianstocks://payment/complete` 回到 APK；在 Supabase 与 Dodo 控制台中登记这两个精确回调地址。原生 `DeepLink` 插件只把回调类型通知给网页层，不记录授权码、支付参数或其他敏感内容。Android 已声明通知权限，Firebase 接入后仍必须在首次需要提醒时由用户主动授权。

当前状态：`@capacitor/push-notifications` 已接入并可编译，设备令牌接口和 Firebase Admin 发送逻辑已接入 Railway/Supabase；由于尚未放入 `google-services.json`，且 Railway 尚未配置 Firebase Admin 凭据，应用会显示“系统推送待配置”，不会申请通知权限。真正的系统推送还需要 Firebase 客户端配置和真机接收验收。

开发验证：

```powershell
npm run android:debug
```

发布 APK 前必须完成：

1. `stocks.cauai.fun` 已通过 Railway 与 Cloudflare 发布 HTTPS。
2. Firebase Android 项目已登记相同包名，`google-services.json` 仅放在 `android/app/`，不提交仓库。
3. Supabase、Dodo 和 Firebase 的允许域名及深链回跳已经在各自控制台配置。
4. 在仓库外生成发布签名密钥，并通过 Android `signingConfigs.release` 引用环境变量或安全路径。

签名配置不会写入仓库。先在仓库外生成一次密钥，并在当前 PowerShell 会话中设置以下变量：

```powershell
keytool -genkeypair -v -keystore 'D:\secure\niannian-stocks-release.jks' -alias niannian-stocks -keyalg RSA -keysize 2048 -validity 10000
$env:NIANNIAN_KEYSTORE_PATH = 'D:\secure\niannian-stocks-release.jks'
$env:NIANNIAN_KEYSTORE_PASSWORD = '<密钥库密码>'
$env:NIANNIAN_KEY_ALIAS = 'niannian-stocks'
$env:NIANNIAN_KEY_PASSWORD = '<签名密码>'
```

正式构建：

```powershell
npm run android:sync
cd android
.\gradlew.bat :app:assembleRelease --no-daemon
cd ..
Get-FileHash .\android\app\build\outputs\apk\release\app-release.apk -Algorithm SHA256
```

如果没有设置四个 `NIANNIAN_*` 变量，正式构建不得发布；调试构建仍可使用 `npm run android:debug`。密钥文件、密码和环境变量不要提交到 Git、APK、网站或日志。

不要发布指向本机、测试 URL，或包含任何服务端密钥的 APK。

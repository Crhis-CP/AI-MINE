# 页面演示截图

由 `node e2e/demo-shots.ts` 生成：用读者端的生产构建，加上本地演示 API（`e2e/demo-api.ts`，数据在 `e2e/demo-reader.ts`）直接截图。演示数据全部是合成的，标有“示例”“演示数据”，不含生产数据、真实公司、密钥或备案号。

规格：
- 桌面 1440×1000，手机 390×844；
- 浅色和深色按系统外观偏好切换；
- 动效按“减少动态效果”关闭；
- 时钟固定为 `e2e/time.ts` 的时间。

重新生成：

```bash
npm run build --workspace @amp/web
node e2e/demo-shots.ts
```

`reader-en.png` 是英文界面（`/en`），资讯内容仍为中文。

`model-settings.png` 是后台模型表单的旧截图，来自合成表单，不在本脚本范围内。

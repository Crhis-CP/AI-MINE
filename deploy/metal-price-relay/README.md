# Cochilco 原件取件服务

仅部署到腾讯云 Makers 免费套餐的海外 CloudFunctions，新加坡区域。付费或超额购买需要 Owner 决定。函数不解析报价，只处理固定官方列表和符合契约的日报 PDF；其余地址、方法、过期或错误签名、重定向、超限及伪 PDF 均拒绝。使用正常 TLS 验证。

`handler.ts` 的 `createPriceRelay(publicKey)` 返回标准 Request → Response 处理器。发布入口导出 `onRequest = ({request}) => relay(request)`，将公共 SPKI PEM 验证密钥编入入口，与契约一起打成 Node 20 ESM 单文件，放到上传目录的 `cloud-functions/v1/cochilco.js`。上传目录仅包含该构建文件、`public/index.html` 和 `edgeone.json`；绝不包含私有签名文件、仓库环境或 CLI 登录材料。

`edgeone.json` 使用 `outputDirectory: public` 与 `cloudFunctions: {regions:{overseas:[ap-singapore]},maxDuration:30}`。官方 CLI `edgeone@1.6.41 makers deploy <上传目录> --name aimine-price-fetch --area overseas --env production --json --skip-ai-gateway-sync`，避免启用不需要的 AI 网关。绑定经 Owner 许可的 `price-fetch.aiminingpolicy.com` 后，从生产主机验证签名列表及真实 PDF 原件；保留前一函数部署作为回退。

私钥原始副本保存在主机 `.credentials/price-relay/signing.pem`，mode 0600、仅应用 UID 可读。发布前运行 `deploy/metal-price-relay/install-key.sh`，将同一私钥幂等写入专用 `amp_price-relay-keys` 卷；只有 worker 只读挂载到 `/run/price-relay`。未配置取价地址时，该空卷不触发任何访问。网站读者、公开 API 及海外服务均不持私钥。不将本服务配置为 `EGRESS_PROXY_URL`，它不是通用代理。停用只清空 `METAL_PRICE_RELAY_URL` 并恢复此前应用版本；保留既有真实报价历史。

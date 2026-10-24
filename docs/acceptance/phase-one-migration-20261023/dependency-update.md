# 依赖安全更新

PR291在2026-10-24 00:15–00:27 UTC完整验证中，功能、迁移、角色、前后台、隔离故障恢复均通过；唯一失败是更新后的npm公告将现有undici与zod列为high。按协作规则8.2独立升级依赖，不豁免审计。

| 层 | 原版本 | 修复版本 |
|---|---|---|
| Zod（全部workspace一致） | 4.6.5 | 4.6.7 |
| Undici直接依赖 | 8.11.2 | 8.12.3 |
| Cheerio传递Undici | 7.30.0 | 7.30.1 |
| Fastify | 5.12.5 | 5.12.7 |
| fast-uri传递依赖 | 3.1.8 / 4.2.1 | 3.1.9 / 4.2.3 |
| 正式容器Node.js | 24.21.0 | 24.22.1 |

官方[Undici公告](https://github.com/nodejs/undici/security/advisories/GHSA-xjj6-f33q-929c)说明异常压缩编码响应可能导致进程退出；[Zod公告](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)列出超大集合校验的资源耗尽问题。Node.js本身内置Undici，不能仅靠升级npm包替换：官方v24.21.0源码记录7.29.1，[v24.22.1安全发布](https://nodejs.org/en/blog/release/v24.22.1)内置7.30.1，因此同步更新正式基础镜像。

新基础镜像为`node:24.22.1-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea`。匿名读取Docker官方registry manifest，字节SHA256与响应摘要一致，确认含Linux amd64与arm64；这是摘要核验，不称为签名验证。保持原Debian发行版、npm11.19.0、禁用安装脚本及至少一天发布等待。

npm发布记录显示选定补丁发布于10月12日至19日，Node24.22.1发布于10月21日，均超过等待期。锁文件只升级7个外部包实例，未顺带更新其他依赖；重新npm ci后audit为0。后续最终SHA完整验证及同一镜像部署仍独立取证，不能把本地审计结果当成已上线。

受限原始证据位于`.verify/module-contract/dependency-audit-fixed.json`、`node-image-24.22.1.json`及依赖安装/锁定日志；生产未在本步骤修改。

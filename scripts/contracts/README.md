# 对外API文档

`npm run contracts:gen`从共享Zod声明生成公开、后台及v3 OpenAPI文档和清单；`npm run contracts:check`检查受管文件全集及实际HTTP兼容用例。生成只创建不监听的声明服务器，不读取业务数据、凭据或调用模型。使用项目统一TypeScript版本，不生成内部客户端。

共享contracts仍是字段与运行时解析的来源。文档在reference/contracts，private与public组件保持隔离；客户端重构不能改变外部URL、字段、状态码或缓存头。

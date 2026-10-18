# 进程配置入口已迁移

配置实现已归入后端的`process-config.ts`，通过既有`@amp/backend/db`入口提供相同函数与类型。本目录不再是独立工作区包；历史职责与角色约束见[进程配置说明](../../../docs/04-architecture/process-database-config.md)。

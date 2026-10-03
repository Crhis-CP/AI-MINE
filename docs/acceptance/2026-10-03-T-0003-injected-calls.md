# T-0003 PR3b：全局 SQL 调用迁移

基点 `38e680efd9448bf639f7ea8e83bf3a340e5e3418`。按 D1 和附录 B 首个归属将 85 个导入改为 dbOf；API/worker、8 个 CLI、基线捕获、测试公共夹具及两个停机子进程显式初始化。全局 sql 创建与导出已删除，业务 SQL 和函数签名不变。

`scripts/db-injection/mapping.json` 给出归属依据和全部 91 个输入文件哈希；rewrite.py 校验全部输入后再写入。从基点干净导出重放，91 个结果与提交逐字节一致。两个新增测试文件的归属由其受测的 notify/deliver、admin/selectbench 公开入口确定；app 的健康查询归 publication，迁移入口归 config。

`pnpm check` 六阶段通过。干净代码检查点 `5355c10` 在同机 Linux、PostgreSQL/pg_dump 16.14 上运行，157 项后端测试通过，冒烟/MCP/前端均退出 0；与已验证的 PR3a 基线每个文件逐字节相同。最终提交的完整 CI、独立审查和合并后主干回执记录在 PR。

源码与改写脚本（排除归属/哈希数据、空行和注释）的有效改动少于 400 行。没有外部依赖变更、生产操作、真实模型调用或旧代码读取。API 尚为过渡角色，双 API、真实登录权限和数据写权按本卡后续步骤完成。

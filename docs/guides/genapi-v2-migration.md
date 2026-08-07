# genapi v2 迁移

这份清单用于从早期 genapi 产物迁移到 v2。先在独立分支重新生成并修复类型，再替换旧产物；不要手工编辑生成文件。

## 兼容与变化

| 项目                                   | v2 行为                                               |
| -------------------------------------- | ----------------------------------------------------- |
| 旧平铺 `{ baseURL, authService, ... }` | 保持兼容                                              |
| 单 service `AllSchemas`                | 保持原语义                                            |
| 多 service `AllSchemas`                | 默认移除                                              |
| 同名短 alias                           | 冲突即失败，不再静默保留第一个                        |
| schema identity                        | `project + service + full schema name`                |
| hooks                                  | `service > project > root`，整对象覆盖，`{}` 停止继承 |
| 生成时间                               | 移除，改由确定性 manifest 记录版本和 hash             |
| 缺失 Swagger                           | 任一 required service 缺失即整体失败                  |
| 外部 `$ref`                            | v2 第一阶段拒绝；先内联或改成本地内部引用             |
| CLI 参数                               | 未知、重复或缺值参数直接失败                          |

## 迁移步骤

1. 校正 project/service ID 为 kebab-case，并清理重复或生成名冲突。
2. 确认每个配置 service 都有 `swagger/<project>/<service>.json`。
3. 运行一次正式生成，再运行只读检查：

   ```bash
   pnpm generate:api myapp
   pnpm run generate:api -- --check
   ```

4. 多 service 代码把 `AllSchemas["X"]` 改成：

   ```ts
   SchemaOf<"service-name", "Full.Schema.Name">;
   ```

5. 如果便利 alias 冲突，使用 `typeExports.aliases` 或带 service 限定的 `typeExports.namespaces` 显式命名。不要依赖 service 顺序。
6. 客户端初始化可以暂时保留平铺配置；需要多地址时再迁移成 `defaults/services`。service 的 `middleware` 是替换，不是拼接。
7. 把非标准 Swagger 修正规则放进相应 service hook。若要禁用继承 hook，显式配置 `hooks: {}`。
8. 标准 enum 保持 literal union；只有需要运行时常量时才启用 `createRuntimeEnumHooks()`。Flags 必须在 metadata 中标记。
9. 运行应用 typecheck、genapi 测试和真实请求地址测试。

## `AllSchemas` 临时兼容

只有 full schema name 在所有 service 中完全唯一时，才可以短期启用：

```ts
compatibility: {
  legacyAllSchemas: true;
}
```

一旦存在重复 full name，生成会失败。这个开关不会恢复旧的静默交叉合并；它只是迁移窗口，最终代码仍应切换到 `SchemaOf`。

## 生成目录与失败恢复

v2 保持 `src/api/gen/<project>` 目录形态。生成期间使用同级 staging、backup 和事务状态文件；成功后不会残留这些内部文件。进程在替换中断时，下一次生成先恢复旧目录再继续。

`--check` 不创建锁、staging、backup 或事务状态，也不会改正式目录。

## 提交前

```bash
pnpm run generate:api -- --check
pnpm typecheck
pnpm verify
```

在 `CHANGELOG.md` 记录移除的多 service `AllSchemas`、新增严格碰撞诊断、hooks 优先级以及是否启用了临时兼容开关。

# UtilityLab

`UtilityLab` 是实验性工具项目的统一迭代管理仓库。

## 目录约定

```text
UtilityLab/
├─ <ProjectName>/        # 一个实验工具对应一个独立项目目录
├─ scripts/git/          # 仓库级 Git 检查脚本
├─ .gitignore            # 敏感信息、数字资产和本地产物排除规则
└─ RULES.md              # 仓库协作与内容管理规则
```

仓库根目录只放置仓库级说明、规则与公共管理工具。项目源码、配置、文档、
测试和迁移产物都应放在对应项目目录内。

## 开始工作

1. 阅读 [RULES.md](RULES.md)。
2. 为新实验创建独立项目目录。
3. 提交前运行：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\git\check-repository-policy.ps1
   ```

> 当前的 `AnimotionHub/` 含有数字创意资产，首次建仓时整体保留在本地，
> 不进入 Git 管理。后续若需公开其中的纯代码，应先整理并单独审核。

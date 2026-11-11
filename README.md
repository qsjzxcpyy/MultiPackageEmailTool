# 多包裹邮件处理工具

本地 Node.js 工具，用于聚合多包裹订单、匹配 ERP 邮箱、生成邮件，并在明确点击发送后逐条发送和查看结果。

## 启动

Windows 用户可以使用目录中的启动脚本：

- `启动工具.bat`
- `启动工具隐藏.vbs`

也可以直接运行：

```powershell
node server.mjs --port 8788
```

启动器会打开本地网页，具体端口以启动脚本和终端输出为准。

## 使用流程

1. 上传云仓导出的 `.xlsx` 工作簿。
2. 导入包含邮箱信息的 ERP 工作簿。
3. 工具按订单号合并物流记录，并保留原始出现顺序。
4. 下载最终邮件数据或人工复核数据。
5. 配置发件邮箱并上传授权码 TXT 后，在第 04 步点击“发送邮件”。处理一封显示一条记录，可搜索、折叠和复制正文，并查看成功、失败、待核对数量。

首次使用须将 `multi_package_email.mjs` 中的店铺和发件邮箱映射改为自己的本地配置。公开版本的 `DEMOA/B/C/D` 和 `example.invalid` 邮箱均为虚构示例。授权码 TXT 每行使用 `发件邮箱----授权码`；文件通过网页保存到本机 `data/mail-settings`，后续默认选中。直接修改当前保存的 TXT 时，发件邮箱数量随文件内容重新统计。

未上传本次文件时邮件总数从 0 开始；生成相同邮件后会复用已有发送结果。正在执行的发送任务重新打开页面仍可查看。发送日志保存在本机 `data/mail-history`，不会提交至仓库。成功表示 SMTP 服务器已接收，待核对不会自动重发。新数据与其他发送记录中的订单、来源、收件邮箱、正文和发件邮箱全部相同，且对方已成功或待核对时，会停止整批发送并提示核对。详细规则见 [发送说明](发送整合说明_20261110.md)。

混合承运商和多物流号的处理规则位于 `multi_package_email.mjs`，页面资源位于 `web/`。

## 开发与检查

- 核心处理逻辑：`multi_package_email.mjs`
- 本地 HTTP 服务：`server.mjs`
- 检查脚本：`internal/checks/`
- 历史输出和上传文件目录：`outputs/`

仓库保留现有 Node.js 运行依赖与虚构表格模板。开发检查使用：

```powershell
node --test internal/tests/*.test.mjs
python -m unittest discover -s internal/tests -p test_sender.py
```

所有邮件测试使用虚构数据和模拟 SMTP，不发送真实邮件。输入样本在临时目录生成，测试不依赖个人桌面文件。

浏览器验收需要 Python Playwright 和 Chromium。在一个终端运行 `node internal/checks/mail_offline_server.mjs ../mail-web-fixtures`，另一个终端运行 `python internal/checks/verify_mail_ui.py ../mail-web-fixtures` 和 `python internal/checks/verify_send_selection.py`。前者使用注入的模拟发送器，后者拦截 HTTP 请求，均不会启动真实发送模块。截图和报告保存在指定的虚构样本目录。

Windows 发送模块位于 `internal/bin/mail_worker.exe`，由 `internal/worker/mail_engine.py` 与 `cli.py` 重新构建，不包含旧桌面发件程序或账号凭据。普通使用无需安装 Python。需要重建时安装 Python 3.12 与 `internal/worker/requirements.txt` 中的依赖，然后运行：

```powershell
powershell -ExecutionPolicy Bypass -File internal/worker/build.ps1
```

EXE 的离线自检入口为 `--offline-self-test REPORT` 与 `--offline-web-worker-test REPORT`，内部阻止网络连接并替换 SMTP。实际发送仅通过显式的 `--web-worker MANIFEST` 入口运行。

## 示例数据与本地配置

公开版本使用虚构的店铺、客户、订单、物流号和文件标识。真实业务表、数据库、截图、个人配置及运行结果不随仓库分发。示例值不能用于连接生产账号。

使用前请在自己的电脑配置店铺映射、发件邮箱、应用及文档 ID，并自行提供业务输入文件。凭据和授权缓存放在被忽略的本地目录；提交前请检查 `git diff --cached`，避免把业务内容写入源码、测试或说明文档。

仓库内附的表格模板由表头结构重新生成，只包含虚构样例，不含原始业务数据或隐藏工作表。生成输出前请按对应平台要求核对模板格式。

`发邮件8.17-1.xlsx` 是重新生成的虚构邮件模板，仅保留“收件邮箱、邮件内容、发件邮箱”表头及一行示例；示例邮箱使用 `example.invalid`，不能作为真实收发地址。

# AI 无线发布：本机控制合同 v1

此画布只展示、连接、保存、排版；没有生图/生视频能力。平台Key留在上级私有凭据文件，由创作CLI调用平台API；不要交给画布。

## 启动和数据

需要Node.js18或以上。预构建包无需npm install，运行 `node serve.mjs`，默认 http://127.0.0.1:3101。安装工具返回的start_environment指定PORT和CANVAS_DATA_DIR，请始终复用同账号固定值。环境变量只给本进程，不修改系统环境或项目.env。

程序版本目录和data_dir分别保存。data_dir/state.json保存项目和命令回执，assets保存原素材和缩略图，control.json是当前本机令牌（不是平台Key，不输出）。备份整个data_dir，不只导出图谱。不要删除已有server.lock或杀占端口进程；启动报占用时先核验旧服务归属。原服务可用 `node <旧版本>/canvas.mjs stop --data <data_dir>` 正常关闭，确认退出后同端口同数据目录启动新版本。异常退出的锁需核实PID和数据备份后再处理，不自动盲删。

## 无需浏览器操作

`node <版本目录>/canvas.mjs <命令> --data <data_dir>` 自动在进程内读取本机令牌，仅输出业务结果。

- `projects`：项目列表；`state`：当前项目完整节点/边/修订号。
- `new --name <项目名>`；`open --id <项目ID>`。
- `media --file <已获授权的本地素材>`：导入素材，返回asset_id/type/data，可直接放到节点。
- `send --file <JSON文件>`：提交下方命令。命令ID固定以便重试；首次成功后保持同ID和内容。
- `arrange --id <项目ID> --layout storyboard|grid [--columns 4]`：按连线分列或网格，只改位置。
- `receipt --id <命令ID>`：读回原回执；`stop`：关闭属于该数据目录的服务。

CLI媒体导入保存原文件。图片可直接展示；需要大量素材时，应由已审阅的本地工具提供thumb64/160/480/1200四档，视频提供静态封面，避免原图反复解码。浏览器“添加素材”可自动生成四档预览。SVG作为img加载，GIF原动图保留；卡片可静态预览，点开看原图。不要把SVG当HTML嵌入或执行其脚本。未经许可不上传本地作品到远程平台。

## HTTP（本机端口）

前缀 `/local/v1`，Bearer取control.json的token，**不是平台Key**。不要把令牌加入URL或对话。只监听127.0.0.1，拒绝异站Origin和伪造Host，不开放CORS。不把端口暴露到公网/局域网。

- GET /projects；GET /projects/{id}；GET /state（active、serial）。
- POST /commands：下方JSON，成功200表示原子落盘。失败400，不应循环重放生成。
- GET /receipts/{id}：回执或null。
- PUT /assets/{asset_id}/{orig|src|t64|t160|t480|t1200}：原始二进制，声明实际Content-Type，最多512MB；已有内容不可改写，重传同内容幂等。
- GET /assets/{asset_id}：可展示相对URL；GET /assets/{asset_id}/{field}：同源媒体读取，视频支持Range；SVG响应沙箱禁止脚本。
- GET /session：同源浏览器初始化本机会话；CLI不必调用。DELETE /server：正常关闭本服务。

命令基础字段 `{protocol:1,id:"命令UUID",type:"...",project_id:"项目ID"}`；id仅英文数字、下划线、短横线，最长100字符，不能使用原型保留名。可加expected_revision，冲突400时先重新读取项目，保护用户未保存内容。

类型：project.create（name），project.open，graph.replace（完整nodes和edges），graph.arrange（layout、columns），generation.record（task_id、prompt、references、outputs、可选position）。graph.replace先读取最新项目，保留无关节点；不要为追加作品覆盖整个项目。

```json
{
  "protocol":1,"id":"example-image-task-101","type":"generation.record","project_id":"example-project",
  "task_id":"101","prompt":"用户确认的提示词",
  "references":[],
  "outputs":[{"id":"image_101","type":"image","position":{"x":440,"y":40},"data":{"title":"图片作品","orig":"https://example.invalid/image.svg","t480":"https://example.invalid/image.svg"}}]
}
```

例子中的域名仅结构演示，实际使用先下载成功作品并调用media导入，以其返回data替换。图生视频references填已有图片节点，outputs填video节点，data.src用导入返回地址；节点必须带id/type/position/data。任务ID最长64字符；原任务ID+节点ID稳定，重复同命令不重复入板。

文生图连“提示词→图片”；图生视频连“参考图片→视频”，并保存文本节点；文生视频连“提示词→视频”。文本使用prompt节点。允许image/video/prompt三种，不支持格式保留原文件并说明。成功后arrange整理，但不改提示词、素材或生成费用。

浏览器打开时约2秒同步本机数据，手势过程中暂停同步。后台/关闭时仍能API落盘，下次打开继续；未核验浏览器实际显示时只汇报“已保存”。浏览器手动编辑与AI竞争会通过revision拒绝覆盖；用户可先导出当前图谱，再重新载入已保存版本。

## 构建和更新

源码React18、Vite5、ReactFlow12，无额外UI框架。修改源码后 `npm ci && npm run build`。不要手改dist。升级用上级领取/更新工具的 `--canvas <profile.json>`，校验固定版本包后安装新目录，保留data_dir和旧版本；不自动改凭据工具或平台权限。

## 环境缺失（Windows / macOS）

首次短命令接入先识别系统与x64/ARM64架构：Windows检查py -3/python、node和curl.exe（PowerShell中的curl可能是别名），Mac检查python3、node，保留已有版本。Python可用后先运行已经审阅的上级领取工具 --doctor [--node <绝对路径>]，环境准备好后才领取一次性凭据。画布预构建包本身只需Node和浏览器，不需要npm install、开发插件或浏览器扩展。

缺Python/Node时，AI先说明官方组件、来源和占用，优先本人目录中的官方仍受支持Python3和Node LTS，核验架构、校验值及可用签名，使用进程级绝对路径，不改系统Python、全局PATH、不默认装Homebrew。需要管理员权限、公司设备策略、交互安装器或无法联网时请用户确认或提供官方离线包；不绕过、不反复试装。成功后真实检查版本、--doctor、健康页和项目接口，再报告可用。Windows/Mac各自实测，没有验证的系统必须标记待验证。

将运行时绝对路径保存到个人profile.canvas_runtime并在后续复用；不要因画布升级重复安装环境。不存在本机终端/文件能力的网页AI不能代装本地服务，需要明确说明。遇到浏览器不支持的媒体编解码保留原文件，提供下载或兼容建议，不自动收费转码。

## GitHub独立客户端首次接入

首次下载请先读仓库根README和skills/youkou-media-creator/SKILL.md：注册 https://erchun.youkou.cc → 开放API → 复制接入命令 → 发给有本机权限的AI。绑定代理原站点时沿原站点接入。未接入时默认首页是注册指引，项目接口会拒绝操作；本机提示不是不可绕过的授权机制，平台生成始终由服务端鉴权。

收到命令后仅由已审阅的客户端领取并保存本人凭据。使用 scripts/onboard.py --profile <profile.json绝对路径> --start 启动画布，脚本在本进程传递CANVAS_PROFILE定位，不向前端交付Key。作品、Key和运行数据都在本人配置目录，不写进仓库。软件商业经营限制、生成作品另按平台规则、正式书面授权代理例外以根LICENSE为准。

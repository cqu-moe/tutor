# 教学任务的官方 Pi 生命周期与文件效果核对

GUI 的内存 job/子进程 stdin 无法在执行者退出后保存接纳、确认或取消；讲解与修订的临时会话不能恢复原阶段；导出的两次 rename 之间可能没有 output。这些失败通过公共 CLI/GUI、真实 SQLite/文件与 SIGKILL 重现。

一个具体的 `tutor.teaching` 官方 task 在数据目录 `.teaching/tasks.sqlite` 拥有接纳输入、阶段 checkpoint 和终态。官方 task document 保存用户决定，Session document 只索引请求身份。该中心负责跨课程任务列表；既有每课程 `.durable/session.sqlite` Harness 仍是模型提交、工具任务和会话的唯一执行记录，不另做模型日志。课程状态仍由 course.json 接口拥有；事实与记忆效果仍由 scoped-memory 官方 document 拥有。

任务前先复制输入和修订原稿，再在一个官方 Tx 内创建 task/决定文档/请求索引。每个模型阶段使用原任务派生的稳定 request/conversation key，反馈从原 tutor.request 祖先获得。官方已完成回答即使尚未推进教学 checkpoint，也能按原 submission 取回。任意 stage 写工具不声明普遍 replay-safe；中断结果无法核对时暂停，不允许模型盲目重做该未知操作。

OCR 身份和已接收结果保存于原阶段；有 batch ID 只查询原 batch，无查询身份的未知动作暂停。发布 checkpoint 保存已验证文件树的内容摘要及确定的候选/previous/output 位置；rename 与 task commit 不宣称跨文件系统事务，恢复必须重新核对实际文件树。章节发布在原课程权威记录中附本次 operationId，防止效果已写而 task 终态未写时重复推进版本。这不是备份服务或通用补偿数据库。

单写者使用永久 inode 的 OS flock。命令监督进程继承同一打开描述符，并在 owner 退出时终止命令进程组；因此不是只看主进程 PID 就允许接管。真实 Python 孙进程写入时 SIGKILL owner 的回归验证了接管前写入停止。macOS ARM64 已本地执行；Linux 原生执行仍须由发行 CI 验证，跨编译不替代它。

stage sandbox 原先把 OCR 环境和自定义 Pi 配置文件内容送回模型，合成秘密回归已复现。修复位于该现有边界：白名单传递文档环境、拒读实际/默认配置目录，以及文件工具对配置路径的校验。原沙箱的写入、硬链接、课程/历史隔离继续生效，没有新安全引擎。

旧无接纳工件保持 pending。只有用户明确继续旧路线时，才复制可用资料并接纳为新的待确认任务；不重放旧会话。取消是官方 aborted 终态；浏览器关闭和执行者退出保持任务原意。详见 [使用说明](../task-resumption.md)。

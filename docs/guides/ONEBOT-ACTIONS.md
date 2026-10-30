# OneBot action 覆盖审计（SnowLuma 实测清单）

> 这份文档回答一个问题：**"更好适配 QQ"到底该接什么？**
> 答案不是逆向 QQ 协议 —— 而是把 OneBot 已经提供的 action 接全。
>
> **方法**：静态扫描 `D:\QQBot\snowluma\index.mjs`（8.9 MB 打包产物）里出现的 action 名，
> 与本仓库 `src/` 里实际调用的 action 做差集。
> **注意**：这是**静态探测**，不等于每个都真机可用（可能受账号权限/版本限制）。
> 逐个确认请用 `node scripts/probe-onebot-actions.mjs`（只探只读 action，无副作用）。

## 一、结论（2026-10-30）

| 指标 | 数量 |
| --- | --- |
| 纳入审计的 action | 65 |
| SnowLuma 源码里存在该名字 | **62** |
| 本仓库已接 | **20** |
| **支持但未接** | **42** |

## 二、已接（20）

| 类别 | action |
| --- | --- |
| 群管理 | `get_group_list` · `get_group_member_info` · `get_group_member_list` |
| 消息 | `get_msg` · `send_msg` · `send_group_msg` · `send_private_msg` · `get_forward_msg` · `send_group_forward_msg` · `send_private_forward_msg` · `get_group_msg_history` |
| 文件与媒体 | `get_image` |
| 社交/资料 | `send_like` |
| 系统 | `get_status` · `get_version_info` · `get_login_info` |
| 空间 | `send_qzone_msg` · `get_qzone_feeds` · `get_qzone_msg_list` · `comment_qzone` |

## 三、支持但未接（42）—— 这就是"更好适配"的空间

| 类别 | action |
| --- | --- |
| 群管理 | `set_group_ban` · `set_group_whole_ban` · `set_group_kick` · `set_group_leave` · `set_group_card` · `set_group_name` · `set_group_anonymous_ban` · `set_group_add_request` · `get_group_system_msg` · `get_group_info` · `get_group_honor_info` · `get_group_at_all_remain` · `get_group_shut_list` |
| 消息 | `delete_msg` · `set_msg_emoji_like` · `send_forward_msg` · `mark_msg_as_read` · `get_friend_msg_history` · `set_essence_msg` · `delete_essence_msg` · `get_essence_msg_list` |
| 文件与媒体 | `get_record` · `get_file` · `upload_group_file` · `upload_private_file` · `get_group_root_files` · `get_group_files_by_folder` · `delete_group_file` · `get_group_file_url` |
| 社交/资料 | `get_stranger_info` · `get_friend_list` · `friend_profile_like` · `set_friend_add_request` · `get_friends_with_category` · `get_profile_like` |
| 系统 | `can_send_image` · `can_send_record` · `clean_cache` · `set_restart` · `get_credentials` · `get_cookies` |
| 空间 | `delete_qzone_msg` |

## 四、建议接入顺序（按"群管理价值 ÷ 风险"）

| 次序 | action | 为什么 | 风险 |
| --- | --- | --- | --- |
| 1 | `get_group_info` · `get_group_list` | 控制台与提示词能显示群名，不再是裸群号 | 无（只读） |
| 2 | `delete_msg` | **发错了能撤回** —— 现在只能干看着 | 低（需管理员或本人） |
| 3 | `set_group_ban` · `set_group_whole_ban` | 刷屏/广告能止血；群管理刚需 | **中**（误操作影响他人） |
| 4 | `set_group_card` | 拟人细节：能给自己改群名片 | 低 |
| 5 | `upload_group_file` | "甩个文件过来" —— 群里最实用的动作之一 | 中（体积/权限） |
| 6 | `get_stranger_info` | 陌生人资料，人物库补全 | 无（只读） |

> 前两条几乎零风险，建议先做；3/4 要**仅管理员 + 二次确认**。

## 五、SnowLuma 源码里没找到的（3）

- `get_group_notice`（群管理）
- `send_group_notice`（群管理）
- `delete_group_notice`（群管理）

可能是打包时改名或未实现；需要真机探测确认。

## 六、为什么不做逆向

| 做法 | 后果 |
| --- | --- |
| 逆向 QQ 客户端协议 | 违反服务条款、账号封禁是终局；且协议一改就要重做 |
| 自建协议层替代 SnowLuma | 把"能升级的依赖"变成"必须自己维护的负债" |
| **接全 OneBot action** | 零协议风险；SnowLuma 升级我们跟着受益 |

桥接站在 OneBot 之上，这层隔离是资产，不要为了"更贴近 QQ"把它拆掉。

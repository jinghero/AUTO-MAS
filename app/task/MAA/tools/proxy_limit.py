"""MAA 每日代理额度预检。"""

from app.models.config import MaaConfig, MaaUserConfig
from app.utils.constants import game_now


async def check_daily_proxy_limit(
    script_config: MaaConfig,
    user_config: MaaUserConfig,
    *,
    is_queue_task: bool,
) -> str | None:
    """按账号区服重置游戏日计数，返回队列代理的额度跳过原因。"""

    curdate = game_now(user_config.get("Info", "Server")).strftime("%Y-%m-%d")
    if user_config.get("Data", "LastProxyDate") != curdate:
        await user_config.set("Data", "LastProxyDate", curdate)
        await user_config.set("Data", "ProxyTimes", 0)

    # 单独运行是用户主动指定的一次性运行；上限为 0 时不限次数。
    limit = script_config.get("Run", "ProxyTimesLimit")
    if is_queue_task and limit != 0 and user_config.get("Data", "ProxyTimes") >= limit:
        return "今日代理次数已达上限, 跳过该用户"
    return None

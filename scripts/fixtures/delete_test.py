import ast
import asyncio
import json
import sys
from pathlib import Path
from types import SimpleNamespace

source = Path(sys.argv[1]).read_text(encoding="utf-8")
tree = ast.parse(source)
function = next(node for node in tree.body if isinstance(node, ast.AsyncFunctionDef) and node.name == "bili_delete")
function.decorator_list = []
calls = []
response = {}
failure = None


class Video:
    def __init__(self, **kwargs):
        calls.append(("video", kwargs))

    async def get_info(self):
        if failure == "info":
            raise RuntimeError("模拟视频失败")
        return {"aid": 456}


class Comment:
    def __init__(self, **kwargs):
        calls.append(("comment", kwargs))

    async def delete(self):
        calls.append(("delete", {}))
        if failure == "delete":
            raise RuntimeError("模拟删除失败")
        return response


def get_cred():
    if failure == "credential":
        raise RuntimeError("模拟未登录")
    return "模拟凭证对象"


namespace = {
    "json": json,
    "get_cred": get_cred,
    "video": SimpleNamespace(Video=Video),
    "comment": SimpleNamespace(Comment=Comment, CommentResourceType=SimpleNamespace(VIDEO=1)),
}
exec(compile(ast.Module(body=[function], type_ignores=[]), "删除测试", "exec"), namespace)


async def main():
    global response, failure
    for response in [{}, None, {"code": 0}]:
        calls.clear()
        result = json.loads(await namespace["bili_delete"]("BV测试", 123))
        assert result["success"] is True
        assert calls == [
            ("video", {"bvid": "BV测试", "credential": "模拟凭证对象"}),
            ("comment", {"oid": 456, "type_": 1, "rpid": 123, "credential": "模拟凭证对象"}),
            ("delete", {}),
        ]
    for response in [{"success": False}, {"ok": False}, {"code": -1}, {"error": "错误"}]:
        assert json.loads(await namespace["bili_delete"]("BV测试", 123))["success"] is False
    for failure in ["credential", "info", "delete"]:
        assert json.loads(await namespace["bili_delete"]("BV测试", 123))["success"] is False
    failure = None
    for rpid in [0, -1, 1.5, True, "123", None, 9007199254740992]:
        calls.clear()
        assert json.loads(await namespace["bili_delete"]("BV测试", rpid))["success"] is False
        assert not calls
    assert json.loads(await namespace["bili_delete"](" ", 123))["success"] is False


asyncio.run(main())
print("通过：Python Comment.delete 隔离替身验证")

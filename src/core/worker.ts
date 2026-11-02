import type {} from "electron";
import { Capture } from "./capture";
import { listPorts } from "./transport";

const capture = new Capture(process.argv[2]);
process.parentPort.on("message", async ({ data }) => {
  const { id, method, args } = data ?? {};
  if (!Number.isSafeInteger(id) || !Array.isArray(args)) return;
  try {
    let result: unknown;
    switch (method) {
      case "ports":
        result = await listPorts(process.env.BAUDLOOM_TEST_MODE === "1");
        break;
      case "connect":
        if (
          args[0]?.source === "synthetic" &&
          process.env.BAUDLOOM_TEST_MODE !== "1"
        )
          throw Error("测试数据源未启用");
        result = await capture.connect(args[0]);
        break;
      case "startRecording":
        result = await capture.startRecording(args[0]);
        break;
      case "setViewLimits":
        result = capture.setViewLimits(args[0]);
        break;
      case "stop":
        result = await capture.stop();
        break;
      case "send":
        if (!args[0] || typeof args[0] !== "object")
          throw Error("无效发送请求");
        result = await capture.send(args[0]);
        break;
      case "startSchedule":
        result = capture.startSchedule(args[0]);
        break;
      case "stopSchedule":
        result = capture.stopSchedule();
        break;
      case "snapshot":
        if (![undefined, "text", "hex"].includes(args[0]))
          throw Error("无效显示格式");
        result = capture.snapshot(args[0], args[1]);
        break;
      case "mark":
        result = await capture.mark(args[0]);
        break;
      case "directory":
        capture.setDirectory(args[0]);
        break;
      case "open":
        result = await capture.openFile(args[0]);
        break;
      default:
        throw Error("未知操作");
    }
    process.parentPort.postMessage({ id, result });
  } catch (error) {
    process.parentPort.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

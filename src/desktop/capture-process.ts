import { utilityProcess } from "electron";
import { join } from "node:path";

export function startCaptureProcess(directory: string, onExit: () => void) {
  let coreError = "";
  let sequence = 0;
  const pending = new Map<
    number,
    {
      resolve: (r: any) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  async function request(method: string, ...args: unknown[]): Promise<any> {
    if (coreError) return Promise.reject(Error(coreError));
    if (pending.size >= 32)
      return Promise.reject(Error("操作过多，请稍后重试"));
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(
        () => {
          pending.delete(id);
          reject(Error("采集进程未及时响应，请检查状态后停止采集"));
        },
        ["open", "export"].includes(method) ? 30 * 60 * 1000 : 15000,
      );
      pending.set(id, { resolve, reject, timer });
      try {
        core.postMessage({ id, method, args });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  }
  const core = utilityProcess.fork(
    join(__dirname, "../core/worker.cjs"),
    [directory],
    { serviceName: "Baudloom Capture", stdio: "pipe" },
  );
  core.on("message", (message: any) => {
    const item = pending.get(message.id);
    if (!item) return;
    clearTimeout(item.timer);
    pending.delete(message.id);
    message.error
      ? item.reject(Error(message.error))
      : item.resolve(message.result);
  });
  core.on("exit", (code) => {
    onExit();
    coreError = `采集进程已退出（${code}），连接已中断。若已启用保存，请重启应用后核对会话文件。`;
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(Error(coreError));
    }
    pending.clear();
  });
  core.stderr?.on("data", (data) => console.error("[capture]", String(data)));

  return { request, kill: () => core.kill() };
}

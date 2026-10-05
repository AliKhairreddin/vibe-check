// Finish bodies while this invocation is alive. Leaving a container response
// unread can pin @cloudflare/containers' in-flight count and prevent sleep.
export async function drainInternalResponse(response: Response, label: string): Promise<void> {
  if (response.body) await response.body.pipeTo(new WritableStream({ write() {} }));
  if (!response.ok) throw new Error(`${label} failed with status ${response.status}`);
}

export async function readInternalJson<T>(response: Response, label: string): Promise<T> {
  if (!response.ok) {
    await drainInternalResponse(response, label);
  }
  // Read the original, not a clone with an abandoned second branch.
  return await response.json() as T;
}

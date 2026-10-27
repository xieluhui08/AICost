// A single owner for the shared dialog. Native close events are queued; an old
// close event must never erase a newly opened dialog or retain a secret field.
export function closeDialog() {
  const dialog = document.querySelector('#modal');
  if (!dialog) return;
  if (dialog.open) dialog.close();
  dialog.replaceChildren();
  delete dialog.dataset.task;
}
export function openDialog(html) {
  const dialog = document.querySelector('#modal');
  delete dialog.dataset.task;
  dialog.innerHTML = '<button type="button" class="close" aria-label="关闭">×</button>' + html;
  dialog.onclose = () => { if (!dialog.open) dialog.replaceChildren(); };
  dialog.oncancel = () => closeDialog();
  dialog.querySelector('.close').onclick = closeDialog;
  if (!dialog.open) dialog.showModal();
  return dialog;
}
export function ownsDialog(element) {
  return !!element?.isConnected && !!document.querySelector('#modal')?.open;
}
export function environment(title, note) {
  const top = document.querySelector('.environment');
  const side = document.querySelector('.side-status strong');
  const sub = document.querySelector('.side-status small');
  if (top) top.textContent = title;
  if (side) side.textContent = title;
  if (sub) sub.textContent = note;
}
export async function jsonRequest(url, options, unavailable) {
  try {
    const res = await fetch(url, {...options, signal: AbortSignal.timeout(15000)});
    if (!(res.headers.get('content-type') || '').includes('application/json')) throw Error(unavailable);
    const body = await res.json();
    if (!res.ok) throw Error(body.error || '请求失败（' + res.status + '）');
    return body;
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') throw Error('请求超时，请检查服务状态后重试。保存结果可能已生效，请先刷新确认。');
    if (error instanceof TypeError) throw Error('无法连接服务，请检查网络和服务状态后重试。');
    throw error;
  }
}

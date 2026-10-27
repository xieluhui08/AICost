#!/usr/bin/env bash
# Run on the owner's Mac. Imports only this release's explicit files.
set -euo pipefail
repo='xieluhui08/AICost'
target='/Users/luhui.xie/AICost'
archive="${1:-$HOME/Downloads/agentguard-source.tar.gz}"
for executable in git gh python3 node npm; do
  command -v "$executable" >/dev/null || { echo "缺少 $executable，请先安装。"; exit 1; }
done
node -e 'const [major,minor]=process.versions.node.split(".").map(Number);if(major<20||(major===20&&minor<19))process.exit(1)' || { echo '需要 Node.js 20.19 或更新版本。'; exit 1; }
test -f "$archive" || { echo "找不到源码包：$archive"; exit 1; }
archive=$(python3 -c 'import pathlib,sys; print(pathlib.Path(sys.argv[1]).resolve())' "$archive")
gh auth status --hostname github.com || { echo '请先在本机执行 gh auth login，然后重试。不要在聊天中发送凭证。'; exit 1; }
gh api "repos/$repo" --jq '.permissions.push' | python3 -c 'import sys; sys.exit(0 if sys.stdin.read().strip()=="true" else 1)' || { echo '当前 GitHub 账号没有仓库写权限。'; exit 1; }
gh auth setup-git --hostname github.com
if [ ! -d "$target" ]; then git clone "https://github.com/$repo.git" "$target"; fi
cd "$target"
test "$(git rev-parse --show-toplevel)" = "$target" || { echo '目标不是独立 Git 仓库。'; exit 1; }
remote=$(git remote get-url origin)
case "$remote" in
  "https://github.com/$repo"|"https://github.com/$repo.git"|"git@github.com:$repo.git") ;;
  *) echo 'origin 与目标仓库不一致，已停止。'; exit 1 ;;
esac
test -z "$(git status --porcelain)" || { echo '本地有未提交文件，请先保存或提交后重试。'; exit 1; }
git fetch origin
if git show-ref --verify --quiet refs/remotes/origin/main; then
  test "$(git branch --show-current)" = main || { echo '请先切换到 main。'; exit 1; }
  git merge --ff-only origin/main
elif ! git rev-parse --verify HEAD >/dev/null 2>&1; then
  git symbolic-ref HEAD refs/heads/main
else
  test "$(git branch --show-current)" = main || { echo '请先切换到 main。'; exit 1; }
fi
git var GIT_AUTHOR_IDENT >/dev/null || { echo '请先配置 git user.name 与 user.email。'; exit 1; }
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
python3 - "$archive" "$target" "$stage" <<'PY'
import sys,tarfile,pathlib,os
archive,target,stage=sys.argv[1:]
root=pathlib.Path(target).resolve()
with tarfile.open(archive) as tar:
    files=[]
    for member in tar.getmembers():
        name=pathlib.PurePosixPath(member.name)
        if not member.isfile() or name.is_absolute() or '..' in name.parts:
            raise SystemExit('源码包包含不允许的路径或文件类型，已停止。')
        if name.parts[0] in {'.git','.openai','data','node_modules'} or name.name=='.env' or name.suffix=='.sqlite':
            raise SystemExit('源码包包含私有配置或数据，已停止。')
        destination=root.joinpath(*name.parts)
        if os.path.commonpath([str(destination.resolve()),str(root)])!=str(root) or destination.is_symlink():
            raise SystemExit('目标路径包含外部符号链接，已停止。')
        data=tar.extractfile(member).read()
        if destination.exists() and (not destination.is_file() or destination.read_bytes()!=data):
            raise SystemExit(f'已有不同内容，未覆盖：{name}。请在本地工作区合并后再发布。')
        files.append((destination,data,str(name)))
    # The distributable archive cannot contain itself; keep its download working.
    bundle=root/'dist/agentguard-source.tar.gz'
    if os.path.commonpath([str(bundle.resolve()),str(root)])!=str(root) or bundle.is_symlink():
        raise SystemExit('源码下载路径包含外部符号链接，已停止。')
    bundle_data=pathlib.Path(archive).read_bytes()
    if bundle.exists() and (not bundle.is_file() or bundle.read_bytes()!=bundle_data):
        raise SystemExit('已有不同的源码下载包，未覆盖。请先在本地合并。')
    files.append((bundle,bundle_data,'dist/agentguard-source.tar.gz'))
    for destination,data,_ in files:
        destination.parent.mkdir(parents=True,exist_ok=True)
        destination.write_bytes(data)
    pathlib.Path(stage,'files').write_text('\n'.join(name for _,_,name in files)+'\n')
PY
npm ci
npm test
while IFS= read -r file; do git add -- "$file"; done < "$stage/files"
if ! git diff --cached --quiet; then git commit -m 'Add AgentGuard usage ledger and frontend'; fi
git push -u origin main
if gh api "repos/$repo/pages" --silent 2>/dev/null; then
  gh api --method PUT "repos/$repo/pages" -f build_type=workflow --silent
else
  gh api --method POST "repos/$repo/pages" -f build_type=workflow --silent
fi
gh workflow run pages.yml --repo "$repo" --ref main
echo '源码已推送，前端发布工作流已触发。'
echo '请在 GitHub Actions 确认 Deploy frontend preview 成功后访问 Pages。'
echo 'Pages 仅提供前端预览；真实账本和模型代理请按 dist/DEPLOY.md 部署到服务器。'
gh api "repos/$repo/pages" --jq '.html_url'

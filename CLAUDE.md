# Discord Bridge - Agent Instructions

## 必須ルール

### ユーザーへの質問・確認

- **選択・確認・質問は必ず `AskUserQuestion` ツールを使う**
- プレーンテキストの質問は Discord 上でボタンに変換されない
- `AskUserQuestion` を使えば自動的に Discord のボタン付きメッセージになり、ユーザーはワンタップで回答できる
- **description には「選択後に何が起きるか」を必ず明記する**（Discord ではボタンと description しか見えないため、結果が予測できない選択肢は NG）

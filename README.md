# marked-faster

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/alfasurya91/marked-faster/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/alfasurya91/marked-faster/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A dependency-free, hand-written Markdown parser that renders exactly the HTML marked 18.1.3 produces with its default options (GitHub-flavored Markdown on), and does it faster. It implements the CommonMark 0.31.2 spec plus the GFM 0.29 extensions — tables, task lists, strikethrough, extended autolinks — including the places where marked departs from the written spec, verified byte-for-byte against all 720 practice cases (680 spec examples and 40 long generated READMEs). `parse.js` is the parser module, `main.ts` is the small driver that renders every case from the input file to the output file.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=6nhb12n2&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>

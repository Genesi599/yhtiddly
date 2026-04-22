#!/usr/bin/env python3
"""
Update the $:/plugins/yh109/ai-normalize plugin to v0.2.0 with Refine mode.

Changes:
  - normalize.js: add $mode="new"/"refine" branch + conversation persistence
  - result-panel: show refine textarea after initial response, update clear macro
  - styles: CSS for refine UI
  - readme: document the refine workflow
  - .meta: bump version 0.1.0 → 0.2.0

Writes:
  1. TidGi source file  D:\TidGi\yhtiddly\tiddlers\system\$__plugins_yh109_ai-normalize.json
  2. TidGi .meta file   same path + .meta (version bump)
  3. Remote             PUT to https://yhtiddly.fun/recipes/default/tiddlers/$:/plugins/yh109/ai-normalize

Run while TWSync is running (or not — doesn't matter; we write to remote directly).
"""

import json, os, sys, urllib.request, urllib.parse

sys.stdout.reconfigure(encoding='utf-8')

TIDGI_JSON = r'D:\TidGi\yhtiddly\tiddlers\system\$__plugins_yh109_ai-normalize.json'
TIDGI_META = TIDGI_JSON + '.meta'
REMOTE     = 'https://yhtiddly.fun'
PLUGIN_TITLE = '$:/plugins/yh109/ai-normalize'


# ────────────────────────────────────────────────────────────────────────────
# New sub-tiddler contents
# ────────────────────────────────────────────────────────────────────────────

NORMALIZE_JS = r'''/*\
title: $:/plugins/yh109/ai-normalize/normalize.js
type: application/javascript
module-type: widget

Action widget. Two modes:
  $mode="new" (default) — fresh normalization of the target tiddler. Resets
    the conversation history and POSTs [system, user(title+tags+text)].
  $mode="refine"         — continues the existing conversation. Reads
    $:/temp/ai/conversation, appends the instruction (from $instruction
    attribute or $:/temp/ai/refine-input), POSTs the whole history.

Conversation persistence: $:/temp/ai/conversation holds the full
[{role,content}, ...] array. Updated after each successful turn. The last
assistant message is mirrored into $:/temp/ai/result so the existing
Apply/Save-new buttons keep working without change.
\*/
(function(){
"use strict";

var Widget = require("$:/core/modules/widgets/widget.js").widget;
var CFG_PREFIX = "$:/plugins/yh109/ai-normalize/config/";

var CONV    = "$:/temp/ai/conversation";
var RESULT  = "$:/temp/ai/result";
var STATUS  = "$:/temp/ai/status";
var SRC     = "$:/temp/ai/source-title";
var STARTED = "$:/temp/ai/started-at";
var ELAPSED = "$:/temp/ai/elapsed-ms";
var REFINE  = "$:/temp/ai/refine-input";
var TURN    = "$:/temp/ai/turn-count";

var AiNormalizeWidget = function(parseTreeNode, options) {
    this.initialise(parseTreeNode, options);
};

AiNormalizeWidget.prototype = new Widget();

AiNormalizeWidget.prototype.render = function(parent, nextSibling) {
    this.computeAttributes();
    this.execute();
};

AiNormalizeWidget.prototype.execute = function() {
    this.targetTiddler = this.getAttribute("$targetTiddler");
    this.mode          = this.getAttribute("$mode", "new");
    this.instruction   = this.getAttribute("$instruction", "");
};

AiNormalizeWidget.prototype.refresh = function() { return false; };

AiNormalizeWidget.prototype.invokeAction = function(triggeringWidget, event) {
    var self = this;
    var wiki = self.wiki;

    function setStatus(s) { wiki.addTiddler({ title: STATUS, text: s }); }
    function saveConv(messages) { wiki.addTiddler({ title: CONV, text: JSON.stringify(messages) }); }
    function clearConv() { wiki.addTiddler({ title: CONV, text: "" }); }

    // Race guard: don't double-fire while a request is in flight.
    if ((wiki.getTiddlerText(STATUS) || "").trim() === "processing") return true;

    var apiUrl = (wiki.getTiddlerText(CFG_PREFIX + "api-url") || "").trim();
    var apiKey = (wiki.getTiddlerText(CFG_PREFIX + "api-key") || "").trim();
    var model  = (wiki.getTiddlerText(CFG_PREFIX + "model")   || "deepseek-chat").trim();
    var systemPrompt = (wiki.getTiddlerText(CFG_PREFIX + "system-prompt") || "").trim();

    if (!apiUrl) { setStatus("error: 未配置 API URL"); return true; }
    if (!apiKey) { setStatus("error: 未配置 API Key（打开控制面板 → 高级 → AI 配置 填入）"); return true; }

    var targetTitle = self.targetTiddler;
    if (!targetTitle) { setStatus("error: 未指定目标 tiddler"); return true; }

    var messages;

    if (self.mode === "refine") {
        // Continue existing conversation.
        var convText = wiki.getTiddlerText(CONV) || "";
        var conv;
        try { conv = JSON.parse(convText); }
        catch (e) { setStatus("error: 对话历史损坏，请点「取消」重置"); return true; }
        if (!Array.isArray(conv) || conv.length < 2) {
            setStatus("error: 没有可追问的对话，请先点「AI 标准化」开始");
            return true;
        }
        var instruction = (self.instruction || wiki.getTiddlerText(REFINE) || "").trim();
        if (!instruction) { setStatus("error: 请输入追问内容"); return true; }

        messages = conv.concat([{ role: "user", content: instruction }]);
        // Persist the pending user turn & clear the input immediately so the
        // UI reflects "sent". If the request fails, we roll back below.
        saveConv(messages);
        wiki.addTiddler({ title: REFINE, text: "" });
    } else {
        // Fresh start: build the initial system+user pair.
        var tiddler = wiki.getTiddler(targetTitle);
        if (!tiddler) { setStatus("error: 目标 tiddler 不存在：" + targetTitle); return true; }

        var text = tiddler.fields.text || "";
        var isEmpty = !text.trim();
        var tagsArr = tiddler.fields.tags || [];
        var tagsStr = tagsArr.length ? tagsArr.join(", ") : "(无)";

        var userContent;
        if (isEmpty) {
            userContent =
                "这是一个空的 tiddler。请根据以下标题和标签生成一份合适的内容，使用 TiddlyWiki 的 wikitext 语法（标题用 `! `、`!! `；列表用 `* `、`# `；加粗用 `''xxx''`；斜体用 `//xxx//`）。直接输出正文，不要加任何前置说明或解释。\n\n" +
                "tiddler 标题：" + targetTitle + "\n" +
                "tiddler 标签：" + tagsStr;
        } else {
            userContent =
                "tiddler 标题：" + targetTitle + "\n" +
                "tiddler 标签：" + tagsStr + "\n\n" +
                "tiddler 当前内容：\n" + text;
        }

        messages = [
            { role: "system", content: systemPrompt },
            { role: "user",   content: userContent }
        ];
        // Reset all session state for a fresh run.
        wiki.addTiddler({ title: RESULT, text: "" });
        wiki.addTiddler({ title: REFINE, text: "" });
        saveConv(messages);
    }

    setStatus("processing");
    wiki.addTiddler({ title: SRC, text: targetTitle });
    wiki.addTiddler({ title: STARTED, text: String(Date.now()) });

    var body = JSON.stringify({
        model: model,
        messages: messages,
        temperature: 0.3
    });

    fetch(apiUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + apiKey
        },
        body: body
    })
    .then(function(r) {
        if (!r.ok) return r.text().then(function(t) { throw new Error("HTTP " + r.status + ": " + t.slice(0, 200)); });
        return r.json();
    })
    .then(function(d) {
        if (d.error) throw new Error(d.error.message || JSON.stringify(d.error));
        if (!d.choices || !d.choices[0] || !d.choices[0].message) throw new Error("bad response: " + JSON.stringify(d).slice(0, 200));
        var reply = d.choices[0].message.content || "";

        messages.push({ role: "assistant", content: reply });
        saveConv(messages);
        wiki.addTiddler({ title: RESULT, text: reply });

        // Turn count = number of assistant replies so far.
        var assistantCount = messages.filter(function(m) { return m.role === "assistant"; }).length;
        wiki.addTiddler({ title: TURN, text: String(assistantCount) });

        var elapsed = Date.now() - parseInt(wiki.getTiddlerText(STARTED) || "0", 10);
        wiki.addTiddler({ title: ELAPSED, text: String(elapsed) });
        setStatus("done");
    })
    .catch(function(e) {
        // Roll back the pending user turn on refine failure so the user can
        // retry without the dangling turn polluting history.
        if (self.mode === "refine") {
            try {
                var arr = JSON.parse(wiki.getTiddlerText(CONV) || "[]");
                if (Array.isArray(arr) && arr.length && arr[arr.length - 1].role === "user") {
                    arr.pop();
                    saveConv(arr);
                }
            } catch (_) {}
        }
        setStatus("error: " + e.message);
    });

    return true;
};

exports["ai-normalize"] = AiNormalizeWidget;

})();
'''

RESULT_PANEL = r'''\whitespace trim

\define ai-clear-state()
<$action-setfield $tiddler="$:/temp/ai/status" text=""/>
<$action-setfield $tiddler="$:/temp/ai/source-title" text=""/>
<$action-setfield $tiddler="$:/temp/ai/elapsed-ms" text=""/>
<$action-setfield $tiddler="$:/temp/ai/conversation" text=""/>
<$action-setfield $tiddler="$:/temp/ai/refine-input" text=""/>
<$action-setfield $tiddler="$:/temp/ai/turn-count" text=""/>
<$action-setfield $tiddler="$:/temp/ai/result" text=""/>
\end

<$reveal type="match" stateTitle="$:/temp/ai/source-title" stateField="text" text=<<currentTiddler>>>

<$reveal type="nomatch" stateTitle="$:/temp/ai/status" stateField="text" text="">
<div class="tc-tiddler-frame yh-ai-panel">

<div class="yh-ai-panel-header">
<span class="yh-ai-panel-icon">{{$:/plugins/yh109/ai-normalize/icon}}</span>
<span>AI 标准化结果</span>
<div class="yh-ai-panel-status">
<$text text={{$:/temp/ai/status}}/>
<$list filter="[[$:/temp/ai/turn-count]get[text]!match[]!match[0]!match[1]]" variable="n">
 · 第 <<n>> 轮
</$list>
<$list filter="[[$:/temp/ai/elapsed-ms]get[text]]" variable="ms">
 · <<ms>> ms
</$list>
</div>
</div>

<$reveal type="match" stateTitle="$:/temp/ai/status" stateField="text" text="processing">
<div class="yh-ai-panel-processing">正在调用 AI，请稍等（一般 5~20 秒）…</div>
</$reveal>

<$reveal type="match" stateTitle="$:/temp/ai/status" stateField="text" text="done">
<div class="yh-ai-panel-result">
<$transclude tiddler="$:/temp/ai/result" mode="block"/>
</div>

<div class="yh-ai-panel-actions">
<$button>
<$action-setfield $tiddler=<<currentTiddler>> text={{$:/temp/ai/result}}/>
<<ai-clear-state>>
✅ 应用到当前 tiddler
</$button>

<$button>
<$action-setfield $tiddler={{{ [<currentTiddler>addsuffix[ · AI 草稿]] }}} text={{$:/temp/ai/result}} tags="AI草稿"/>
<<ai-clear-state>>
📝 保存为新 tiddler
</$button>

<$button>
<<ai-clear-state>>
取消
</$button>
</div>

<div class="yh-ai-panel-refine">
<div class="yh-ai-panel-refine-label">不满意？告诉 AI 怎么改：</div>
<$edit-text tiddler="$:/temp/ai/refine-input" tag="textarea" rows="1" class="yh-ai-panel-refine-input" placeholder="例如：再简化一下 / 加一段原理 / 改成表格 / 去掉第二段"/>
<$button class="yh-ai-panel-refine-btn">
<$ai-normalize $targetTiddler=<<currentTiddler>> $mode="refine"/>
🔄 继续优化
</$button>
</div>
</$reveal>

<$list filter="[[$:/temp/ai/status]get[text]prefix[error]]" variable="err">
<div class="yh-ai-panel-error"><<err>></div>
<$button>
<<ai-clear-state>>
关闭
</$button>
</$list>

</div>
</$reveal>

</$reveal>
'''

STYLES = r'''.yh-ai-panel {
	margin: 1em 0;
	padding: .75em 1em;
	background: <<colour tiddler-background>>;
	color: <<colour foreground>>;
	border: 1px solid <<colour tiddler-border>>;
	border-left: 3px solid <<colour primary>>;
	border-radius: 4px;
}

.yh-ai-panel-header {
	font-weight: 600;
	margin-bottom: .5em;
	display: flex;
	align-items: center;
	gap: .5em;
	color: <<colour foreground>>;
}

.yh-ai-panel-icon {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 1.1em;
	height: 1.1em;
	flex: 0 0 auto;
	color: <<colour foreground>>;
}

.yh-ai-panel-icon svg {
	width: 100% !important;
	height: 100% !important;
	fill: <<colour foreground>> !important;
}

.yh-ai-panel-icon svg path {
	fill: <<colour foreground>> !important;
}

.yh-ai-panel-status {
	margin-left: auto;
	font-size: .85em;
	font-weight: normal;
	color: <<colour muted-foreground>>;
}

.yh-ai-panel-processing {
	color: <<colour muted-foreground>>;
	font-size: .95em;
	padding: .25em 0;
}

.yh-ai-panel-result {
	background: <<colour page-background>>;
	color: <<colour foreground>>;
	border: 1px solid <<colour tiddler-border>>;
	padding: .5em 1em;
	margin: .5em 0;
	border-radius: 4px;
}

.yh-ai-panel-actions {
	display: flex;
	gap: .5em;
	margin-top: .75em;
	flex-wrap: wrap;
}

.yh-ai-panel-error {
	color: <<colour alert-foreground>>;
	background: <<colour alert-background>>;
	border: 1px solid <<colour alert-border>>;
	padding: .5em 1em;
	margin: .5em 0;
	border-radius: 4px;
}

/* ── Refine mode (multi-turn) ─────────────────────────────────────── */
.yh-ai-panel-refine {
	margin-top: .75em;
	padding-top: .75em;
	border-top: 1px dashed <<colour tiddler-border>>;
	display: flex;
	flex-direction: column;
	gap: .4em;
}

.yh-ai-panel-refine-label {
	font-size: .85em;
	color: <<colour muted-foreground>>;
}

.yh-ai-panel-refine-input {
	width: 100%;
	height: 2em;
	min-height: 2em;
	font: inherit;
	line-height: 1.4;
	padding: .25em .5em;
	background: <<colour page-background>>;
	color: <<colour foreground>>;
	border: 1px solid <<colour tiddler-border>>;
	border-radius: 4px;
	resize: vertical;
	box-sizing: border-box;
}

.yh-ai-panel-refine-btn {
	align-self: flex-start;
}
'''

README = r'''! AI Normalize

用 OpenAI 兼容 API 标准化当前 tiddler 的格式和内容，支持多轮迭代修改。

!! 基本用法

# 在控制面板 → 高级 → AI 配置 里填入 API Key
# 打开任意 tiddler，右上角工具栏点 ✨ AI 标准化 按钮
# 等 5~20 秒
# tiddler 正文下方出现 AI 处理后的结果
# 选择：''应用到当前 tiddler'' / ''保存为新 tiddler'' / ''取消''

!! Refine 模式（多轮对话）

在初次结果出来后，结果面板下方有一个输入框。可以输入追加指令让 AI 继续改：

* `再简化一下`
* `加一段原理说明`
* `改成表格形式`
* `去掉第二段，换成列表`

点 ''🔄 继续优化'' 按钮，AI 会在完整历史的基础上（记得自己之前说过什么）给出新版本。右上角会显示当前是第几轮。可以反复追问，直到满意为止。

点任何 ''应用'' / ''保存'' / ''取消'' 按钮都会结束这一轮对话并清空历史。

!! 可配置项

* API URL：$:/plugins/yh109/ai-normalize/config/api-url
* API Key：$:/plugins/yh109/ai-normalize/config/api-key
* 模型名：$:/plugins/yh109/ai-normalize/config/model
* System Prompt：$:/plugins/yh109/ai-normalize/config/system-prompt

!! 内部状态 tiddler

（调试用，正常不用管）

* `$:/temp/ai/status` — processing / done / error: ...
* `$:/temp/ai/result` — 最后一轮 AI 回复，Apply 按钮取自这里
* `$:/temp/ai/conversation` — JSON 数组，完整对话历史
* `$:/temp/ai/refine-input` — 追问输入框的绑定
* `$:/temp/ai/turn-count` — 当前第几轮
* `$:/temp/ai/source-title` — 当前会话针对的 tiddler 标题（用于面板门控）

!! 支持的 API

任何 OpenAI Chat Completions API 兼容的端点：

* OpenAI 官方
* DeepSeek 官方
* 国产聚合服务（硅基流动、星狐等）
* 自建 OneAPI / New-API
* Ollama（`http://localhost:11434/v1/chat/completions`）

!! 安全提示

API Key 存在 tiddler 里，保存 wiki 为 HTML 时会一起导出。分享 HTML 前记得清空 Key 或单独导出。
'''


# ────────────────────────────────────────────────────────────────────────────
# Mutate the packaged plugin JSON
# ────────────────────────────────────────────────────────────────────────────

def load_plugin_json():
    with open(TIDGI_JSON, 'r', encoding='utf-8') as f:
        return json.load(f)

def save_plugin_json(data):
    with open(TIDGI_JSON, 'w', encoding='utf-8') as f:
        # Match original single-line layout
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))

def update_subtiddler(pkg, title, fields):
    pkg['tiddlers'][title] = fields

pkg = load_plugin_json()
print(f'Loaded plugin JSON, {len(pkg["tiddlers"])} sub-tiddlers')

update_subtiddler(pkg, '$:/plugins/yh109/ai-normalize/normalize.js', {
    'title': '$:/plugins/yh109/ai-normalize/normalize.js',
    'text': NORMALIZE_JS,
    'type': 'application/javascript',
    'module-type': 'widget'
})

update_subtiddler(pkg, '$:/plugins/yh109/ai-normalize/result-panel', {
    'title': '$:/plugins/yh109/ai-normalize/result-panel',
    'tags': '$:/tags/ViewTemplate',
    'list-after': '$:/core/ui/ViewTemplate/body',
    'type': 'text/vnd.tiddlywiki',
    'text': RESULT_PANEL
})

update_subtiddler(pkg, '$:/plugins/yh109/ai-normalize/styles', {
    'title': '$:/plugins/yh109/ai-normalize/styles',
    'tags': '$:/tags/Stylesheet',
    'type': 'text/vnd.tiddlywiki',
    'text': STYLES
})

update_subtiddler(pkg, '$:/plugins/yh109/ai-normalize/readme', {
    'title': '$:/plugins/yh109/ai-normalize/readme',
    'type': 'text/vnd.tiddlywiki',
    'text': README
})

save_plugin_json(pkg)
print(f'Saved updated plugin JSON to {TIDGI_JSON}')


# ────────────────────────────────────────────────────────────────────────────
# Bump version in .meta
# ────────────────────────────────────────────────────────────────────────────

with open(TIDGI_META, 'r', encoding='utf-8') as f:
    meta_lines = f.readlines()

for i, line in enumerate(meta_lines):
    if line.startswith('version:'):
        old = line.strip()
        meta_lines[i] = 'version: 0.2.1\n'
        print(f'{old} → version: 0.2.1')
        break

with open(TIDGI_META, 'w', encoding='utf-8') as f:
    f.writelines(meta_lines)
print(f'Saved updated meta to {TIDGI_META}')


# ────────────────────────────────────────────────────────────────────────────
# PUT the packaged plugin to remote so TWSync picks it up immediately
# ────────────────────────────────────────────────────────────────────────────

# Re-read the meta to get the full field set (we need to send all fields in the PUT body)
with open(TIDGI_META, 'r', encoding='utf-8') as f:
    meta_fields = {}
    for line in f:
        if ':' in line:
            k, v = line.split(':', 1)
            meta_fields[k.strip()] = v.strip()

# Build the remote PUT body: all header fields + text (the JSON blob)
payload = dict(meta_fields)
payload['title'] = PLUGIN_TITLE
payload['text']  = json.dumps(pkg, ensure_ascii=False, separators=(',', ':'))
# Strip server-only meta
for k in ('revision', 'bag'):
    payload.pop(k, None)

put_url = REMOTE + '/recipes/default/tiddlers/' + urllib.parse.quote(PLUGIN_TITLE, safe='')
req = urllib.request.Request(
    put_url,
    data=json.dumps(payload, ensure_ascii=False).encode('utf-8'),
    headers={
        'Content-Type': 'application/json; charset=utf-8',
        'X-Requested-With': 'TiddlyWiki'
    },
    method='PUT'
)
with urllib.request.urlopen(req, timeout=30) as resp:
    print(f'PUT remote: {resp.status}   Etag: {resp.headers.get("Etag")}')

print('\nDone. Restart TWSync (or reload the wiki page) to pick up v0.2.0.')

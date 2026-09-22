package wtf.pana.neocode.jetbrains.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.editor.Editor

/**
 * Right-click editor action: "Add to Neocode Context".
 *
 * Flow:
 *   1. Read selection from `Editor` (selected text); fall back to the current line if empty
 *   2. Resolve the file path + language ID from `PsiFile` / `VirtualFile`
 *   3. Build JSON payload `{ text, filePath, language }`
 *   4. Send `mcp__ide__addToContext` notification to the connected Neocode session
 *      via [wtf.pana.neocode.jetbrains.services.MCPService.sendAddToContext]
 *
 * Visibility: enabled only when MCPService reports a connected Neocode session.
 */
class SendToClaudeAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return
        val project = e.getData(CommonDataKeys.PROJECT) ?: return
        val psiFile = e.getData(CommonDataKeys.PSI_FILE)

        val selectedText = editor.selectionModel.selectedText
            ?: fallbackLine(editor)
            ?: return

        val virtualFile = psiFile?.virtualFile
        val filePath = virtualFile?.path

        val language = psiFile?.language?.id

        wtf.pana.neocode.jetbrains.services.MCPService.getInstance()
            .sendAddToContext(text = selectedText, filePath = filePath, language = language)

        // Suppress unused-variable warning for `project`; future milestones may
        // route via per-project MCP service instance instead of the application one.
        @Suppress("UNUSED_VARIABLE") val _unused = project
    }

    /**
     * When the user has no selection, send the trimmed contents of the current line.
     * Returns null for empty/whitespace-only lines so the action becomes a no-op.
     */
    private fun fallbackLine(editor: Editor): String? {
        val document = editor.document
        val offset = editor.caretModel.offset
        val safeOffset = offset.coerceAtMost(document.textLength)
        val lineNumber = document.getLineNumber(safeOffset)
        val lineStart = document.getLineStartOffset(lineNumber)
        val lineEnd = document.getLineEndOffset(lineNumber)
        val raw = document.charsSequence.subSequence(lineStart, lineEnd).toString()
        val trimmed = raw.trim()
        return trimmed.ifEmpty { null }
    }

    override fun update(e: AnActionEvent) {
        val editor = e.getData(CommonDataKeys.EDITOR)
        val connected = wtf.pana.neocode.jetbrains.services.MCPService.getInstance().isConnected
        e.presentation.isEnabled = editor != null && connected
    }
}

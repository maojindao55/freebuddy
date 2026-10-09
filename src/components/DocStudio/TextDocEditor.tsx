import React, { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Sparkles, Eye, Code } from "lucide-react";
import { useTranslation } from "react-i18next";

interface TextDocEditorProps {
  content: string;
  isMarkdown: boolean;
  onChange: (newContent: string) => void;
  onAskAi: (selectedText: string) => void;
}

export const TextDocEditor: React.FC<TextDocEditorProps> = ({
  content,
  isMarkdown,
  onChange,
  onAskAi
}) => {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"edit" | "preview" | "split">(isMarkdown ? "split" : "edit");
  const [selectedText, setSelectedText] = useState("");

  const handleTextareaSelect = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const target = e.target as HTMLTextAreaElement;
    const start = target.selectionStart;
    const end = target.selectionEnd;
    if (start !== end) {
      setSelectedText(content.substring(start, end));
    } else {
      setSelectedText("");
    }
  };

  return (
    <div className="ds-textdoc">
      <div className="ds-toolbar ds-textdoc-toolbar">
        <div className="ds-textdoc-actions">
          {selectedText && (
            <button
              type="button"
              onClick={() => onAskAi(selectedText)}
              className="ds-btn ds-btn-secondary"
            >
              <Sparkles size={13} />
              <span>{t("docStudio.aiPolish")}</span>
            </button>
          )}

          {isMarkdown && (
            <div className="ds-segmented">
              <button
                type="button"
                onClick={() => setMode("edit")}
                className={`ds-segment ${mode === "edit" ? "ds-segment-active" : ""}`}
              >
                <Code size={13} />
                <span>{t("docStudio.editMode")}</span>
              </button>
              <button
                type="button"
                onClick={() => setMode("split")}
                className={`ds-segment ${mode === "split" ? "ds-segment-active" : ""}`}
              >
                <span>{t("docStudio.splitMode")}</span>
              </button>
              <button
                type="button"
                onClick={() => setMode("preview")}
                className={`ds-segment ${mode === "preview" ? "ds-segment-active" : ""}`}
              >
                <Eye size={13} />
                <span>{t("docStudio.previewMode")}</span>
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="ds-textdoc-body">
        {(mode === "edit" || mode === "split") && (
          <div className={`ds-textdoc-pane ${mode === "split" ? "ds-textdoc-pane-split" : ""}`}>
            <textarea
              value={content}
              onChange={(e) => onChange(e.target.value)}
              onSelect={handleTextareaSelect}
              className="ds-textarea"
              placeholder={t("docStudio.textPlaceholder")}
              spellCheck={false}
            />
          </div>
        )}

        {(mode === "preview" || mode === "split") && isMarkdown && (
          <div className="ds-textdoc-pane ds-md-preview">
            <div className="markdown-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

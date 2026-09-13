import AppKit
import Foundation
import UniformTypeIdentifiers

@objc(ShareViewController)
class ShareViewController: NSViewController {

    private struct SharedFileItem {
        let name: String
        let sourceURL: URL?
        let imageData: Data?
    }

    private var shareTexts: [String] = []
    private var shareFiles: [SharedFileItem] = []
    private var shareUrls: [URL] = []
    private var isDispatched = false

    private let iconImageView = NSImageView()
    private let titleLabel = NSTextField(labelWithString: "发送到 FreeBuddy")
    private let subtitleLabel = NSTextField(labelWithString: "正在读取内容...")
    private let previewScrollView = NSScrollView()
    private let previewTextView = NSTextView()
    private let instructionField = NSTextField()
    private let cancelButton = NSButton(title: "取消", target: nil, action: nil)
    private let sendButton = NSButton(title: "发送", target: nil, action: nil)
    private let progressIndicator = NSProgressIndicator()

    private func logDebug(_ msg: String) {
        let line = "[\(Date())] \(msg)\n"
        if let data = line.data(using: .utf8) {
            let logURL = URL(fileURLWithPath: "/tmp/freebuddy-share.log")
            if let handle = try? FileHandle(forWritingTo: logURL) {
                handle.seekToEndOfFile()
                handle.write(data)
                try? handle.close()
            } else {
                try? data.write(to: logURL)
            }
        }
    }

    override func loadView() {
        let container = NSView(frame: NSRect(x: 0, y: 0, width: 420, height: 280))
        container.wantsLayer = true
        self.view = container
        self.preferredContentSize = NSSize(width: 420, height: 280)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        self.preferredContentSize = NSSize(width: 420, height: 280)
        let isDev = Bundle.main.bundleIdentifier?.contains(".dev") == true
        if isDev {
            titleLabel.stringValue = "发送到 FreeBuddy Dev"
        }
        setupUI()
        extractShareItems()
    }

    private func setupUI() {
        view.subviews.forEach { $0.removeFromSuperview() }

        // Icon
        iconImageView.imageScaling = .scaleProportionallyUpOrDown
        iconImageView.translatesAutoresizingMaskIntoConstraints = false
        if let iconImage = NSImage(named: "AppIcon") ?? NSApplication.shared.applicationIconImage {
            iconImageView.image = iconImage
        } else if #available(macOS 11.0, *) {
            iconImageView.image = NSImage(systemSymbolName: "sparkles", accessibilityDescription: "FreeBuddy")
        }
        view.addSubview(iconImageView)

        // Title
        titleLabel.font = NSFont.systemFont(ofSize: 15, weight: .bold)
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(titleLabel)

        // Subtitle
        subtitleLabel.font = NSFont.systemFont(ofSize: 12, weight: .regular)
        subtitleLabel.textColor = .secondaryLabelColor
        subtitleLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(subtitleLabel)

        // Preview TextView inside ScrollView
        previewScrollView.borderType = .bezelBorder
        previewScrollView.hasVerticalScroller = true
        previewScrollView.translatesAutoresizingMaskIntoConstraints = false
        previewTextView.isEditable = false
        previewTextView.font = NSFont.systemFont(ofSize: 12)
        previewTextView.textColor = .labelColor
        previewTextView.backgroundColor = .controlBackgroundColor
        previewTextView.autoresizingMask = [.width]
        previewScrollView.documentView = previewTextView
        view.addSubview(previewScrollView)

        // Instruction field
        instructionField.placeholderString = "附加提示词 (可选，例如: 帮我总结、提炼代办事项)"
        instructionField.font = NSFont.systemFont(ofSize: 12)
        instructionField.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(instructionField)

        // Progress
        progressIndicator.style = .spinning
        progressIndicator.controlSize = .small
        progressIndicator.isDisplayedWhenStopped = false
        progressIndicator.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(progressIndicator)

        // Buttons
        cancelButton.target = self
        cancelButton.action = #selector(onCancelClicked(_:))
        cancelButton.keyEquivalent = "\u{1b}" // Escape
        cancelButton.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(cancelButton)

        sendButton.target = self
        sendButton.action = #selector(onSendClicked(_:))
        sendButton.keyEquivalent = "\r" // Enter
        sendButton.bezelStyle = .rounded
        sendButton.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(sendButton)

        NSLayoutConstraint.activate([
            iconImageView.topAnchor.constraint(equalTo: view.topAnchor, constant: 16),
            iconImageView.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 18),
            iconImageView.widthAnchor.constraint(equalToConstant: 36),
            iconImageView.heightAnchor.constraint(equalToConstant: 36),

            titleLabel.topAnchor.constraint(equalTo: view.topAnchor, constant: 14),
            titleLabel.leadingAnchor.constraint(equalTo: iconImageView.trailingAnchor, constant: 12),
            titleLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -18),

            subtitleLabel.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 3),
            subtitleLabel.leadingAnchor.constraint(equalTo: iconImageView.trailingAnchor, constant: 12),
            subtitleLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -18),

            previewScrollView.topAnchor.constraint(equalTo: iconImageView.bottomAnchor, constant: 12),
            previewScrollView.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 18),
            previewScrollView.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -18),
            previewScrollView.heightAnchor.constraint(equalToConstant: 110),

            instructionField.topAnchor.constraint(equalTo: previewScrollView.bottomAnchor, constant: 10),
            instructionField.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 18),
            instructionField.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -18),
            instructionField.heightAnchor.constraint(equalToConstant: 24),

            cancelButton.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -14),
            cancelButton.trailingAnchor.constraint(equalTo: sendButton.leadingAnchor, constant: -10),
            cancelButton.widthAnchor.constraint(equalToConstant: 75),
            cancelButton.heightAnchor.constraint(equalToConstant: 28),

            sendButton.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -14),
            sendButton.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -18),
            sendButton.widthAnchor.constraint(equalToConstant: 80),
            sendButton.heightAnchor.constraint(equalToConstant: 28),

            progressIndicator.centerYAnchor.constraint(equalTo: sendButton.centerYAnchor),
            progressIndicator.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 18)
        ])
    }

    private func extractShareItems() {
        guard let items = extensionContext?.inputItems as? [NSExtensionItem], !items.isEmpty else {
            subtitleLabel.stringValue = "未检测到可转发内容"
            progressIndicator.stopAnimation(nil)
            return
        }

        logDebug("extractShareItems: found \(items.count) input items")
        progressIndicator.startAnimation(nil)
        let dispatchGroup = DispatchGroup()

        for (itemIndex, item) in items.enumerated() {
            logDebug("Item #\(itemIndex): attributedContentText=\(item.attributedContentText?.string ?? "nil"), title=\(item.attributedTitle?.string ?? "nil")")

            if let text = item.attributedContentText?.string,
               !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                shareTexts.append(text)
            }

            guard let attachments = item.attachments else { continue }
            logDebug("Item #\(itemIndex) has \(attachments.count) attachments")

            for (providerIndex, provider) in attachments.enumerated() {
                let registeredTypes = provider.registeredTypeIdentifiers
                logDebug("Provider #\(providerIndex) registeredTypes: \(registeredTypes), suggestedName: \(provider.suggestedName ?? "nil")")

                // Priority 1: File URL
                if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                    dispatchGroup.enter()
                    provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { [weak self] (result, err) in
                        defer { dispatchGroup.leave() }
                        self?.logDebug("Loaded fileURL result: \(type(of: result)), err: \(String(describing: err))")
                        if let url = result as? URL ?? (result as? NSURL as URL?) {
                            self?.shareFiles.append(SharedFileItem(name: url.lastPathComponent, sourceURL: url, imageData: nil))
                        } else if let data = result as? Data {
                            if let url = URL(dataRepresentation: data, relativeTo: nil), url.isFileURL {
                                self?.shareFiles.append(SharedFileItem(name: url.lastPathComponent, sourceURL: url, imageData: nil))
                            }
                        }
                    }
                }
                // Priority 2: Image
                else if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                    dispatchGroup.enter()
                    provider.loadItem(forTypeIdentifier: UTType.image.identifier, options: nil) { [weak self] (result, err) in
                        defer { dispatchGroup.leave() }
                        self?.logDebug("Loaded image result: \(type(of: result)), err: \(String(describing: err))")
                        if let url = result as? URL ?? (result as? NSURL as URL?), url.isFileURL {
                            self?.shareFiles.append(SharedFileItem(name: url.lastPathComponent, sourceURL: url, imageData: nil))
                        } else if let image = result as? NSImage {
                            if let tiff = image.tiffRepresentation,
                               let rep = NSBitmapImageRep(data: tiff),
                               let png = rep.representation(using: .png, properties: [:]) {
                                let name = provider.suggestedName ?? "image_\(Int(Date().timeIntervalSince1970)).png"
                                self?.shareFiles.append(SharedFileItem(name: name, sourceURL: nil, imageData: png))
                            }
                        } else if let data = result as? Data {
                            let name = provider.suggestedName ?? "image_\(Int(Date().timeIntervalSince1970)).png"
                            self?.shareFiles.append(SharedFileItem(name: name, sourceURL: nil, imageData: data))
                        }
                    }
                }
                // Priority 3: Plain Text / UTF-8 Text
                else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier)
                    || registeredTypes.contains(where: { $0.contains("text") || $0.contains("string") || $0.contains("String") }) {
                    let textType = registeredTypes.first { $0 == UTType.utf8PlainText.identifier || $0 == UTType.plainText.identifier }
                        ?? registeredTypes.first { UTType($0)?.conforms(to: .plainText) == true }
                        ?? UTType.plainText.identifier

                    dispatchGroup.enter()
                    provider.loadItem(forTypeIdentifier: textType, options: nil) { [weak self] (result, err) in
                        defer { dispatchGroup.leave() }
                        self?.logDebug("Loaded text result: \(type(of: result)), err: \(String(describing: err))")
                        if let str = result as? String {
                            self?.shareTexts.append(str)
                        } else if let attr = result as? NSAttributedString {
                            self?.shareTexts.append(attr.string)
                        } else if let data = result as? Data {
                            if let str = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .utf16) {
                                self?.shareTexts.append(str)
                            }
                        }
                    }
                }
                // Priority 4: Web URL
                else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                    dispatchGroup.enter()
                    provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { [weak self] (result, err) in
                        defer { dispatchGroup.leave() }
                        self?.logDebug("Loaded url result: \(type(of: result)), val: \(String(describing: result)), err: \(String(describing: err))")
                        if let url = result as? URL ?? (result as? NSURL as URL?) {
                            self?.shareUrls.append(url)
                        }
                    }
                }
                // Priority 5: Any other data/content
                else if let firstType = registeredTypes.first {
                    dispatchGroup.enter()
                    provider.loadItem(forTypeIdentifier: firstType, options: nil) { [weak self] (result, err) in
                        defer { dispatchGroup.leave() }
                        self?.logDebug("Loaded fallback result: \(type(of: result)), err: \(String(describing: err))")
                        if let url = result as? URL ?? (result as? NSURL as URL?), url.isFileURL {
                            self?.shareFiles.append(SharedFileItem(name: url.lastPathComponent, sourceURL: url, imageData: nil))
                        } else if let str = result as? String {
                            self?.shareTexts.append(str)
                        } else if let data = result as? Data {
                            if let str = String(data: data, encoding: .utf8), !str.isEmpty {
                                self?.shareTexts.append(str)
                            } else {
                                let name = provider.suggestedName ?? "attachment_\(Int(Date().timeIntervalSince1970))"
                                self?.shareFiles.append(SharedFileItem(name: name, sourceURL: nil, imageData: data))
                            }
                        }
                    }
                }
            }
        }

        dispatchGroup.notify(queue: .main) { [weak self] in
            guard let self = self else { return }
            self.progressIndicator.stopAnimation(nil)
            self.logDebug("dispatchGroup finished: texts=\(self.shareTexts.count), files=\(self.shareFiles.count), urls=\(self.shareUrls.count)")
            self.updatePreview()
        }
    }

    private func updatePreview() {
        var summaryLines: [String] = []

        if !shareFiles.isEmpty {
            summaryLines.append("📎 文件 (\(shareFiles.count) 个):")
            for file in shareFiles {
                summaryLines.append("  • \(file.name)")
            }
        }

        if !shareUrls.isEmpty {
            if !summaryLines.isEmpty { summaryLines.append("") }
            summaryLines.append("🔗 链接:")
            for u in shareUrls {
                summaryLines.append("  • \(u.absoluteString)")
            }
        }

        if !shareTexts.isEmpty {
            if !summaryLines.isEmpty { summaryLines.append("") }
            summaryLines.append(shareTexts.joined(separator: "\n\n"))
        }

        let fullText = summaryLines.joined(separator: "\n")
        previewTextView.string = fullText.isEmpty ? "（准备就绪）" : fullText

        let fileCount = shareFiles.count
        let textCount = shareTexts.count
        if fileCount > 0 && textCount > 0 {
            subtitleLabel.stringValue = "包含 \(fileCount) 个文件和文本消息"
        } else if fileCount > 0 {
            subtitleLabel.stringValue = "包含 \(fileCount) 个文件"
        } else if textCount > 0 {
            subtitleLabel.stringValue = "包含文本消息"
        } else if !shareUrls.isEmpty {
            subtitleLabel.stringValue = "包含 \(shareUrls.count) 个链接"
        } else {
            subtitleLabel.stringValue = "就绪"
        }
    }

    @IBAction func onSendClicked(_ sender: Any?) {
        guard !isDispatched else { return }
        isDispatched = true
        sendButton.isEnabled = false
        cancelButton.isEnabled = false
        subtitleLabel.stringValue = "正在发送到 FreeBuddy..."
        progressIndicator.startAnimation(nil)

        let instruction = instructionField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        dispatchToFreeBuddy(instruction: instruction.isEmpty ? nil : instruction)
    }

    @IBAction func onCancelClicked(_ sender: Any?) {
        let cancelError = NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError, userInfo: nil)
        extensionContext?.cancelRequest(withError: cancelError)
    }

    private func dispatchToFreeBuddy(instruction: String?) {
        let shareId = UUID().uuidString

        let fileManager = FileManager.default
        let appSupport = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let inboxDir = appSupport.appendingPathComponent("FreeBuddy/share-inbox", isDirectory: true)
        try? fileManager.createDirectory(at: inboxDir, withIntermediateDirectories: true)

        var savedFileInfos: [[String: Any]] = []
        for file in shareFiles {
            let targetFileName = "\(UUID().uuidString)_\(file.name)"
            let targetURL = inboxDir.appendingPathComponent(targetFileName)

            if let sourceURL = file.sourceURL {
                do {
                    if fileManager.fileExists(atPath: targetURL.path) {
                        try fileManager.removeItem(at: targetURL)
                    }
                    try fileManager.copyItem(at: sourceURL, to: targetURL)
                    let attr = try? fileManager.attributesOfItem(atPath: targetURL.path)
                    let fileSize = (attr?[.size] as? NSNumber)?.intValue ?? 0
                    savedFileInfos.append([
                        "name": file.name,
                        "path": targetURL.path,
                        "size": fileSize
                    ])
                } catch {
                    logDebug("Failed to copy file: \(error)")
                }
            } else if let data = file.imageData {
                do {
                    try data.write(to: targetURL)
                    savedFileInfos.append([
                        "name": file.name,
                        "path": targetURL.path,
                        "size": data.count
                    ])
                } catch {
                    logDebug("Failed to save image data: \(error)")
                }
            }
        }

        var combinedText = shareTexts.joined(separator: "\n\n")
        if !shareUrls.isEmpty {
            let urlsText = shareUrls.map { $0.absoluteString }.joined(separator: "\n")
            if combinedText.isEmpty {
                combinedText = urlsText
            } else {
                combinedText += "\n\n" + urlsText
            }
        }

        let payloadPath = inboxDir.appendingPathComponent("\(shareId).json")
        let payload: [String: Any] = [
            "id": shareId,
            "timestamp": Date().timeIntervalSince1970 * 1000,
            "instruction": instruction ?? "",
            "text": combinedText,
            "files": savedFileInfos
        ]

        if let data = try? JSONSerialization.data(withJSONObject: payload, options: .prettyPrinted) {
            try? data.write(to: payloadPath)
        }

        let encodedPath = payloadPath.path.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        let isDev = Bundle.main.bundleIdentifier?.contains(".dev") == true
        let schemeString = isDev ? "freebuddy-dev://share?id=\(shareId)&path=\(encodedPath)" : "freebuddy://share?id=\(shareId)&path=\(encodedPath)"
        logDebug("Dispatching scheme: \(schemeString)")

        if let url = URL(string: schemeString) {
            logDebug("Dispatching scheme: \(schemeString)")
            var opened = NSWorkspace.shared.open(url)
            logDebug("NSWorkspace.shared.open returned: \(opened)")
            if !opened && isDev, let fallbackUrl = URL(string: "freebuddy://share?id=\(shareId)&path=\(encodedPath)") {
                opened = NSWorkspace.shared.open(fallbackUrl)
            }
            if !opened, let context = self.extensionContext {
                context.open(url, completionHandler: nil)
            }
        }
        self.extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
    }
}

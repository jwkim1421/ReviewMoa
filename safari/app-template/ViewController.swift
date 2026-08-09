import UIKit
import WebKit

final class ViewController: UIViewController, WKNavigationDelegate, WKScriptMessageHandler {
    @IBOutlet var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()
        webView.navigationDelegate = self
        webView.configuration.userContentController.add(self, name: "controller")
        guard let page = Bundle.main.url(forResource: "Main", withExtension: "html") else { return }
        webView.loadFileURL(page, allowingReadAccessTo: Bundle.main.resourceURL!)
    }

    deinit {
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "controller")
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard
            message.name == "controller",
            let payload = message.body as? [String: Any],
            let action = payload["action"] as? String
        else { return }

        let destination: URL?
        switch action {
        case "openReviewMoa":
            destination = URL(string: "https://reviewmoa.kro.kr")
        case "openPrivacy":
            destination = URL(string: "https://reviewmoa.kro.kr/privacy.html")
        default:
            destination = nil
        }
        if let destination { UIApplication.shared.open(destination) }
    }
}

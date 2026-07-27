import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Clock3,
  ExternalLink,
  Github,
  Lightbulb,
  LoaderCircle,
  MessageSquarePlus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Star,
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import type { ProductIdentity, Report, ReviewCapability } from "./domain/types";
import { ProductUrlError, resolveProductInput } from "./domain/url";
import { analyzeProduct, probeProduct } from "./lib/api";
import { createLocalReport } from "./domain/analyze";
import { collectWithExtension, hasCollectorExtension } from "./lib/extension";

const sources = ["네이버", "쿠팡", "컬리", "오늘의집", "11번가", "SSG닷컴", "G마켓"];
type View = "home" | "probing" | "report" | "ideas";

function formatDate(value: string) {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function App() {
  const [url, setUrl] = useState("");
  const [view, setView] = useState<View>(() => window.location.hash === "#ideas" ? "ideas" : "home");
  const [product, setProduct] = useState<ProductIdentity>();
  const [capability, setCapability] = useState<ReviewCapability>();
  const [report, setReport] = useState<Report>();
  const [error, setError] = useState("");
  const [probeStep, setProbeStep] = useState(0);

  useEffect(() => {
    if (view !== "probing") return;
    const timer = window.setInterval(() => setProbeStep((value) => Math.min(value + 1, 2)), 550);
    return () => window.clearInterval(timer);
  }, [view]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const resolved = resolveProductInput(url);
      setProduct(resolved);
      setView("probing");
      setProbeStep(0);
      const result = await probeProduct(resolved);
      setCapability(result.capability);
      if (result.report) {
        setReport(result.report);
        setView("report");
        return;
      }
      setProbeStep(2);
      const extensionInstalled = await hasCollectorExtension();
      if (!extensionInstalled) {
        const nextReport = await analyzeProduct(resolved);
        setReport(nextReport);
        setView("report");
        return;
      }
      const collection = await collectWithExtension(resolved, (status) => {
        setCapability((previous) => ({
          status: status.status === "waiting_for_login" ? "login_required" : previous?.status ?? "partial",
          hasReviewArea: previous?.hasReviewArea ?? true,
          supportsNewestSort: previous?.supportsNewestSort ?? false,
          supportsRatingFilter: previous?.supportsRatingFilter ?? false,
          requiresLogin: status.status === "waiting_for_login",
          message:
            status.status === "waiting_for_login"
              ? "상품 탭에서 로그인한 뒤 확장 프로그램의 ‘다시 확인’을 눌러 주세요."
              : status.status === "waiting_for_user"
                ? "상품 탭에서 리뷰 영역이나 CAPTCHA를 직접 확인해 주세요."
                : "공개된 리뷰를 정리하고 있습니다.",
        }));
      });
      const nextReport = import.meta.env.VITE_API_BASE
        ? await analyzeProduct(resolved, collection.reviews)
        : createLocalReport(
            resolved,
            collection.reviews ?? [],
            collection.product?.name ?? "상품 리뷰 분석",
          );
      setReport(nextReport);
      setView("report");
    } catch (caught) {
      setError(caught instanceof ProductUrlError || caught instanceof Error ? caught.message : "URL을 확인하지 못했습니다.");
      setView("home");
    }
  }

  async function refresh() {
    if (!product) return;
    setView("probing");
    setProbeStep(0);
    const nextReport = await analyzeProduct(product);
    setReport(nextReport);
    setView("report");
  }

  function reset() {
    if (window.location.hash) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    }
    setView("home");
    setReport(undefined);
    setCapability(undefined);
    setError("");
  }

  function showIdeas() {
    window.location.hash = "ideas";
    setView("ideas");
  }

  return (
    <main>
      <Nav onHome={reset} onIdeas={showIdeas} ideasActive={view === "ideas"} />
      {view === "home" && <Home url={url} setUrl={setUrl} onSubmit={submit} error={error} />}
      {view === "probing" && product && <Probe product={product} step={probeStep} capability={capability} />}
      {view === "report" && report && <ReportView report={report} onRefresh={refresh} onBack={reset} />}
      {view === "ideas" && <IdeasPage onBack={reset} />}
    </main>
  );
}

function Nav({
  onHome,
  onIdeas,
  ideasActive,
}: {
  onHome: () => void;
  onIdeas: () => void;
  ideasActive: boolean;
}) {
  return (
    <nav className="nav">
      <button className="brand brand-button" onClick={onHome} aria-label="리뷰모아 홈">
        <span className="brand-mark"><Star size={18} fill="currentColor" /></span>
        리뷰모아
      </button>
      <div className="nav-actions">
        <button className={`idea-nav ${ideasActive ? "active" : ""}`} onClick={onIdeas}>
          <Lightbulb size={15} /> 아이디어 기여
        </button>
        <span className="beta">PRIVATE BETA</span>
      </div>
    </nav>
  );
}

function Home({
  url,
  setUrl,
  onSubmit,
  error,
}: {
  url: string;
  setUrl: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  error: string;
}) {
  return (
    <>
      <section className="hero">
        <div className="eyebrow"><Sparkles size={15} /> 구매 전에, 리뷰부터 제대로</div>
        <h1>리뷰는 많아도,<br /><em>판단은 쉬워야 합니다.</em></h1>
        <p className="lead">상품 주소 하나면 충분해요.{"\n"}별점별 최신 리뷰를 고르게 살피고,{"\n"}의심 신호는 덜어내 핵심만 보여드려요.</p>
        <form className={`search-box ${error ? "has-error" : ""}`} onSubmit={onSubmit}>
          <Search size={21} aria-hidden="true" />
          <input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="상품 URL을 붙여넣어 주세요"
            aria-label="상품 URL"
          />
          <button type="submit">리뷰 확인 <ArrowRight size={18} /></button>
        </form>
        {error ? <p className="form-error"><AlertTriangle size={14} /> {error}</p> : (
          <p className="search-note"><ShieldCheck size={14} /> 먼저 리뷰 접근 가능 여부를 확인하며, 로그인 정보는 저장하지 않습니다.</p>
        )}
      </section>
      <section className="sources" aria-label="지원 쇼핑몰">
        <p>우선 지원 쇼핑몰</p>
        <div>{sources.map((source) => <span key={source}><Check size={13} /> {source}</span>)}</div>
      </section>
      <section className="features">
        <Feature number="01" title="별점마다 공평하게">최소 별점에서 최대 별점까지{"\n"}최근 리뷰를 최대 100개씩 살펴봅니다.</Feature>
        <Feature number="02" title="의심 신호는 따로">협찬 표시, 중복 문장, 별점과 본문의 불일치를 분석에서 분리합니다.</Feature>
        <Feature number="03" title="근거가 보이는 결론">한 줄 결론과 신뢰도, 별점별 대표 원문까지{"\n"}함께 확인합니다.</Feature>
      </section>
    </>
  );
}

function Feature({ number, title, children }: { number: string; title: string; children: React.ReactNode }) {
  return <article><span className="number">{number}</span><h2>{title}</h2><p>{children}</p></article>;
}

function IdeasPage({ onBack }: { onBack: () => void }) {
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("새 기능");
  const [details, setDetails] = useState("");

  function submitIdea(event: FormEvent) {
    event.preventDefault();
    const issueTitle = `[${category}] ${title.trim()}`;
    const issueBody = [
      "## 제안 내용",
      details.trim(),
      "",
      "## 기대하는 변화",
      "<!-- 이 아이디어로 무엇이 더 좋아질지 적어주세요. -->",
      "",
      "---",
      "리뷰모아 아이디어 기여 페이지에서 작성되었습니다.",
    ].join("\n");
    const issueUrl = new URL("https://github.com/jwkim1421/ReviewMoa/issues/new");
    issueUrl.searchParams.set("title", issueTitle);
    issueUrl.searchParams.set("body", issueBody);
    window.open(issueUrl, "_blank", "noopener,noreferrer");
  }

  return (
    <section className="ideas-page">
      <button className="text-button" onClick={onBack}><ArrowLeft size={16} /> 홈으로 돌아가기</button>
      <div className="ideas-intro">
        <div>
          <span className="ideas-kicker"><Lightbulb size={15} /> BUILD WITH US</span>
          <h1>리뷰모아를 더 쓸모 있게<br /><em>함께 만들어 주세요.</em></h1>
          <p>불편했던 점, 새로 필요한 기능, 더 정확한 분석 방법을 제안해 주세요. 공개 저장소에서 제안의 진행 과정도 함께 확인할 수 있습니다.</p>
        </div>
        <a className="issues-link" href="https://github.com/jwkim1421/ReviewMoa/issues" target="_blank" rel="noreferrer">
          <Github size={18} /> 등록된 아이디어 보기 <ExternalLink size={14} />
        </a>
      </div>

      <div className="ideas-layout">
        <form className="idea-form" onSubmit={submitIdea}>
          <div className="form-heading">
            <MessageSquarePlus size={21} />
            <div><h2>새 아이디어 기여하기</h2><p>작성 후 GitHub에서 내용을 한 번 더 확인하고 등록합니다.</p></div>
          </div>
          <label>
            <span>분류</span>
            <select value={category} onChange={(event) => setCategory(event.target.value)}>
              <option>새 기능</option>
              <option>리뷰 수집</option>
              <option>AI 분석</option>
              <option>화면 개선</option>
              <option>오류 제보</option>
              <option>기타</option>
            </select>
          </label>
          <label>
            <span>아이디어 제목</span>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="어떤 점이 더 좋아지면 좋을까요?"
              required
              maxLength={100}
            />
          </label>
          <label>
            <span>자세한 내용</span>
            <textarea
              value={details}
              onChange={(event) => setDetails(event.target.value)}
              placeholder="현재 불편한 점과 원하는 동작을 구체적으로 알려주세요."
              required
              rows={7}
              maxLength={3000}
            />
          </label>
          <button className="idea-submit" type="submit">
            GitHub에서 기여 등록하기 <ArrowRight size={17} />
          </button>
          <p className="github-note"><Github size={13} /> 등록하려면 GitHub 로그인이 필요하며, 작성 내용은 공개됩니다.</p>
        </form>

        <aside className="contribution-guide">
          <span className="section-label">좋은 제안의 기준</span>
          <ol>
            <li><strong>문제를 먼저 알려주세요.</strong><span>어떤 상황에서 무엇이 불편했는지 적어주세요.</span></li>
            <li><strong>원하는 결과를 설명해 주세요.</strong><span>구현 방식보다 사용자가 얻게 될 변화를 알려주세요.</span></li>
            <li><strong>예시가 있다면 더 좋아요.</strong><span>상품 URL이나 화면 예시를 개인정보 없이 첨부해 주세요.</span></li>
          </ol>
          <div className="contribution-promise">
            <ShieldCheck size={18} />
            <p><strong>모든 제안을 바로 구현한다고 약속할 수는 없지만,</strong> 검토 결과와 진행 상태는 공개 이슈에서 투명하게 남기겠습니다.</p>
          </div>
        </aside>
      </div>
    </section>
  );
}

function Probe({ product, step, capability }: { product: ProductIdentity; step: number; capability?: ReviewCapability }) {
  const items = [
    { title: "상품 주소 확인", detail: `${product.sourceLabel} · ${product.productId}` },
    { title: "리뷰 영역 탐색", detail: "리뷰 탭과 최신순 정렬을 확인합니다." },
    { title: "별점별 리뷰 준비", detail: capability?.message ?? "수집 가능한 범위를 계산합니다." },
  ];
  return (
    <section className="probe-page">
      <div className="probe-kicker">REVIEW CHECK</div>
      <h1>리뷰를 읽을 수 있는지<br />먼저 확인하고 있어요.</h1>
      <p>접근 실패를 리뷰 0개로 표시하지 않도록 수집 전에 상품과 리뷰 영역을 검증합니다.</p>
      <div className="probe-list">
        {items.map((item, index) => (
          <div className={`probe-item ${index < step ? "done" : index === step ? "active" : ""}`} key={item.title}>
            <span>{index < step ? <Check size={18} /> : index === step ? <LoaderCircle className="spin" size={18} /> : index + 1}</span>
            <div><strong>{item.title}</strong><p>{item.detail}</p></div>
          </div>
        ))}
      </div>
      <div className="probe-privacy"><ShieldCheck size={17} /> 로그인이나 CAPTCHA가 필요하면 작업을 멈추고 직접 완료한 뒤 이어갈 수 있어요.</div>
    </section>
  );
}

function ReportView({ report, onRefresh, onBack }: { report: Report; onRefresh: () => void; onBack: () => void }) {
  const [openRating, setOpenRating] = useState<number | null>(null);
  const confidenceLabel = report.confidence >= 80 ? "높음" : report.confidence >= 60 ? "보통" : "낮음";
  const totalIncluded = useMemo(() => report.ratings.reduce((sum, item) => sum + item.included, 0), [report]);
  const analysis = report.analysis ?? {
    positive: report.strengths[0]
      ? `${report.strengths[0].label}에 대한 만족이 반복적으로 확인됐어요.`
      : "뚜렷하게 반복되는 좋은 점은 아직 확인되지 않았어요.",
    negative: report.cautions[0]
      ? `${report.cautions[0].label}에 대한 불만이 있어 구매 전에 확인이 필요해요.`
      : "반복적으로 나타나는 큰 불만은 아직 확인되지 않았어요.",
    conclusion: report.verdict,
  };

  return (
    <div className="report-shell">
      <header className="report-header">
        <button className="text-button" onClick={onBack}><ArrowLeft size={16} /> 다른 상품 확인</button>
        <div>
          {report.demo && <span className="demo-badge">개발 모드 샘플</span>}
          <span className="source-pill">{report.product.sourceLabel}</span>
        </div>
        <h1>{report.product.name}</h1>
        <a href={report.product.canonicalUrl} target="_blank" rel="noreferrer">원본 상품 보기 <ExternalLink size={13} /></a>
        <div className="cache-banner">
          <Clock3 size={16} />
          <span><strong>{formatDate(report.collectedAt)}</strong> 기준으로 수집한 결과입니다.</span>
          <button onClick={onRefresh}><RefreshCw size={14} /> 다시 불러오기</button>
        </div>
      </header>

      <section className="verdict-card">
        <div className="verdict-copy">
          <span className="section-label">AI 분석 결과</span>
          <div className="analysis-lines">
            <p><strong>좋은 점</strong><span>{analysis.positive}</span></p>
            <p><strong>아쉬운 점</strong><span>{analysis.negative}</span></p>
            <p className="analysis-conclusion"><strong>결론</strong><span>{analysis.conclusion}</span></p>
          </div>
          <p>정상 리뷰 {totalIncluded.toLocaleString()}개의 반복 의견을 바탕으로 정리했어요.</p>
        </div>
        <div className="confidence">
          <div className="confidence-ring" style={{ "--score": `${report.confidence * 3.6}deg` } as React.CSSProperties}>
            <span><strong>{report.confidence}</strong><small>/100</small></span>
          </div>
          <div><span>신뢰도 {confidenceLabel}</span><small>{report.confidenceReasons[0]}</small></div>
        </div>
      </section>
      <details className="confidence-explain">
        <summary>신뢰도 점수는 어떻게 계산하나요?</summary>
        <div>
          <span><strong>35%</strong> 별점별 수집 완성도</span>
          <span><strong>25%</strong> 반복 근거의 강도</span>
          <span><strong>20%</strong> 의견의 일관성</span>
          <span><strong>10%</strong> 리뷰 최신성</span>
          <span><strong>10%</strong> 의심 신호를 제외한 데이터 건전성</span>
        </div>
        <p>구매 성공 확률이 아니라, 이번 결론을 뒷받침하는 리뷰 데이터가 얼마나 충분하고 일관적인지를 나타냅니다.</p>
      </details>

      <section className="insight-grid">
        <InsightList title="사도 좋은 이유" items={report.strengths} tone="positive" />
        <InsightList title="구매 전 확인할 점" items={report.cautions} tone="caution" />
      </section>

      <section className="ratings-section">
        <div className="section-heading">
          <div><span className="section-label">별점별 최신 리뷰</span><h2>평점마다 다른 이야기를 확인하세요.</h2></div>
          <p>의심 리뷰를 제외한 최신 리뷰를 별점별 최대 100개까지 반영합니다.</p>
        </div>
        <div className="rating-list">
          {report.ratings.map((item) => (
            <article className="rating-card" key={item.rating}>
              <button className="rating-summary" onClick={() => setOpenRating(openRating === item.rating ? null : item.rating)}>
                <span className="rating-number">{item.rating}<Star size={16} fill="currentColor" /></span>
                <span className="rating-copy"><strong>{item.included === 0 ? `${item.rating}점 리뷰 0개` : item.summary}</strong><small>검사 {item.checked}개 · 선정 {item.included}개 · 제외 {item.excluded}개</small></span>
                <span className="review-toggle">10개 리뷰 보기 <ChevronDown className={openRating === item.rating ? "rotated" : ""} size={18} /></span>
              </button>
              {openRating === item.rating && (
                <div className="review-panel">
                  {item.reviews.length ? item.reviews.slice(0, 10).map((review, index) => (
                    <blockquote key={review.id}>
                      <header><span>구매자 {String(index + 1).padStart(2, "0")}</span><time>{review.createdAt ? formatDate(review.createdAt).split(" 오전")[0].split(" 오후")[0] : "작성일 미상"}</time></header>
                      <p>{review.content}</p>
                    </blockquote>
                  )) : <p className="empty-reviews">정상적으로 확인된 최근 {item.rating}점 리뷰가 없습니다.</p>}
                </div>
              )}
            </article>
          ))}
        </div>
      </section>

      <section className="anomaly-card">
        <div><span className="section-label">제외된 리뷰 신호</span><h2>결론에서 덜어낸 리뷰</h2><p>거짓 리뷰로 단정하지 않고, 분석 신호에서만 분리했습니다.</p></div>
        <div className="anomaly-stats">
          <span><strong>{report.anomalyCounts.sponsored}</strong>광고성 의심</span>
          <span><strong>{report.anomalyCounts.duplicate}</strong>중복</span>
          <span><strong>{report.anomalyCounts.rating_mismatch}</strong>평점 불일치</span>
          <span><strong>{report.anomalyCounts.uncertain}</strong>판단 유보</span>
        </div>
      </section>

      {report.limitations.map((limitation) => <p className="limitation" key={limitation}><AlertTriangle size={14} /> {limitation}</p>)}
    </div>
  );
}

function InsightList({
  title,
  items,
  tone,
}: {
  title: string;
  items: Array<{ label: string; mentions: number; ratio: number }>;
  tone: "positive" | "caution";
}) {
  return (
    <article className={`insight-card ${tone}`}>
      <span className="section-label">{title}</span>
      {items.map((item, index) => (
        <div className="insight-row" key={item.label}>
          <span className="rank">0{index + 1}</span>
          <div><strong>{item.label}</strong><small>{item.mentions}개 리뷰에서 언급 · {Math.round(item.ratio * 100)}%</small></div>
          <div className="mini-bar"><span style={{ width: `${Math.min(item.ratio * 230, 100)}%` }} /></div>
        </div>
      ))}
    </article>
  );
}

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
  X,
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import type { JobSnapshot, JobStatus, ProductIdentity, Report } from "./domain/types";
import { ProductUrlError, resolveProductInput } from "./domain/url";
import { createJob, getAdminDiagnostics, getJob, refreshJob } from "./lib/api";
import type { AdminDiagnosticJob, AdminDiagnostics } from "./lib/api";
import {
  getMobileHandoffState,
  hasCollectorExtension,
  startMobileHandoff,
} from "./lib/extension";

const sources = ["네이버", "쿠팡", "컬리", "오늘의집", "11번가", "SSG닷컴", "G마켓"];
type View = "home" | "probing" | "report" | "ideas" | "admin";
const STORED_JOB_KEY = "reviewmoa.activeJobId";
const ADMIN_TOKEN_KEY = "reviewmoa.adminToken";
const operatorTokenKey = (jobId: string) => `reviewmoa.operatorToken.${jobId}`;

function isIphoneSafari() {
  const agent = window.navigator.userAgent;
  return /iPhone/i.test(agent) &&
    /Safari/i.test(agent) &&
    !/(CriOS|FxiOS|EdgiOS|OPiOS)/i.test(agent);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function cleanReviewText(value: string) {
  return value.replace(/(?:더보기\s*)?(?:이미지\s*펼치기\s*)+$/u, "").trim();
}

export function App() {
  const [url, setUrl] = useState("");
  const [view, setView] = useState<View>(() => {
    if (window.location.hash === "#ideas") return "ideas";
    if (window.location.hash === "#admin") return "admin";
    return "home";
  });
  const [product, setProduct] = useState<ProductIdentity>();
  const [jobId, setJobId] = useState<string>();
  const [job, setJob] = useState<JobSnapshot>();
  const [report, setReport] = useState<Report>();
  const [error, setError] = useState("");
  const [handoffStarting, setHandoffStarting] = useState(false);
  const [handoffError, setHandoffError] = useState("");

  useEffect(() => {
    if (["#ideas", "#admin"].includes(window.location.hash)) return;
    // 확장 팝업의 "현재 페이지 리뷰 수집"이 넘긴 URL은 아래 전용 effect가 처리한다.
    if (new URL(window.location.href).searchParams.get("collect")) return;
    const urlJobId = new URL(window.location.href).searchParams.get("job");
    const storedJobId = window.localStorage.getItem(STORED_JOB_KEY);
    const restoredJobId = urlJobId || storedJobId;
    if (!restoredJobId) return;
    setJobId(restoredJobId);
    setView("probing");
  }, []);

  useEffect(() => {
    if (["#ideas", "#admin"].includes(window.location.hash)) return;
    const target = new URL(window.location.href).searchParams.get("collect");
    if (!target) return;
    // 새로고침 시 재수집되지 않도록 파라미터를 제거한 뒤 자동으로 수집을 시작한다.
    const cleaned = new URL(window.location.href);
    cleaned.searchParams.delete("collect");
    window.history.replaceState(null, "", cleaned);
    setUrl(target);
    void startCollection(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 화면(홈→수집→보고서)이 바뀔 때마다 최상단으로 스크롤해, 이전 스크롤 위치가
  // 남아 수집 화면이 중간부터 보이는 문제를 막는다.
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [view]);

  useEffect(() => {
    if (view !== "probing" || !jobId) return;
    const activeJobId = jobId;
    let cancelled = false;
    let timer: number | undefined;

    async function poll() {
      try {
        const snapshot = await getJob(activeJobId);
        if (cancelled) return;
        setJob(snapshot);
        setProduct(snapshot.product);
        setError("");
        if (snapshot.report && ["completed", "partial"].includes(snapshot.status)) {
          setReport(snapshot.report);
          setView("report");
          return;
        }
        if (!["failed", "cancelled"].includes(snapshot.status)) {
          timer = window.setTimeout(poll, 1_500);
        }
      } catch (caught) {
        if (cancelled) return;
        setError(caught instanceof Error ? caught.message : "작업 상태를 확인하지 못했습니다.");
        timer = window.setTimeout(poll, 3_000);
      }
    }

    void poll();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [jobId, view]);

  useEffect(() => {
    if (
      view !== "probing" ||
      !jobId ||
      job?.status !== "waiting_for_operator"
    ) return;
    let cancelled = false;
    let timer: number | undefined;

    async function inspectHandoff() {
      try {
        const state = await getMobileHandoffState();
        if (cancelled) return;
        const result = state.result;
        const active = state.activeJob;
        const matchesJob = result?.jobId === jobId || active?.id === jobId;
        if (
          matchesJob &&
          result?.message &&
          !["completed", "partial"].includes(result.status)
        ) {
          setHandoffError(result.message);
        }
      } catch {
        // The extension may be unavailable on non-Safari clients.
      }
      if (!cancelled) timer = window.setTimeout(inspectHandoff, 1_500);
    }

    void inspectHandoff();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [job?.status, jobId, view]);

  function rememberJob(id: string, operatorToken?: string) {
    setJobId(id);
    window.localStorage.setItem(STORED_JOB_KEY, id);
    if (operatorToken) {
      window.localStorage.setItem(operatorTokenKey(id), operatorToken);
    }
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("job", id);
    nextUrl.hash = "";
    window.history.replaceState(null, "", nextUrl);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    await startCollection(url);
  }

  async function startCollection(inputUrl: string) {
    setError("");
    setHandoffError("");
    try {
      const resolved = resolveProductInput(inputUrl);
      setProduct(resolved);
      setView("probing");
      setJob(undefined);
      const useIphoneCollector = isIphoneSafari();
      if (useIphoneCollector && !(await hasCollectorExtension())) {
        throw new Error("리뷰모아 Safari 확장에 연결하지 못했습니다. Safari를 다시 연 뒤 확장 접근 권한을 확인해 주세요.");
      }
      const created = await createJob(
        resolved,
        useIphoneCollector ? { collector: "ios-safari" } : undefined,
      );
      rememberJob(created.id, created.operatorToken);
      setJob({
        id: created.id,
        status: created.status,
        product: created.product ?? resolved,
        report: created.report,
      });
      if (created.report) {
        setReport(created.report);
        setView("report");
      } else if (useIphoneCollector && created.operatorToken) {
        setHandoffStarting(true);
        try {
          await startMobileHandoff({
            jobId: created.id,
            operatorToken: created.operatorToken,
            url: resolved.canonicalUrl,
          });
        } catch (caught) {
          setHandoffError(
            caught instanceof Error
              ? caught.message
              : "iPhone에서 상품 페이지를 열지 못했습니다.",
          );
        } finally {
          setHandoffStarting(false);
        }
      }
    } catch (caught) {
      setError(caught instanceof ProductUrlError || caught instanceof Error ? caught.message : "URL을 확인하지 못했습니다.");
      setView("home");
    }
  }

  async function refresh() {
    if (!jobId) return;
    setError("");
    setHandoffStarting(true);
    try {
      const useIphoneCollector = isIphoneSafari();
      if (useIphoneCollector && !(await hasCollectorExtension())) {
        throw new Error("리뷰모아 Safari 확장에 연결하지 못했습니다. Safari를 다시 연 뒤 확장 접근 권한을 확인해 주세요.");
      }
      const refreshed = await refreshJob(
        jobId,
        useIphoneCollector ? { collector: "ios-safari" } : undefined,
      );
      rememberJob(refreshed.id, refreshed.operatorToken);
      setView("probing");
      setReport(undefined);
      setJob({
        id: refreshed.id,
        status: refreshed.status,
        product: refreshed.product ?? product!,
      });
      if (useIphoneCollector && refreshed.operatorToken && product) {
        await startMobileHandoff({
          jobId: refreshed.id,
          operatorToken: refreshed.operatorToken,
          url: product.canonicalUrl,
        });
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "리뷰를 다시 수집하지 못했습니다.");
      setView(report ? "report" : "home");
    } finally {
      setHandoffStarting(false);
    }
  }

  function reset() {
    if (jobId) {
      window.localStorage.removeItem(operatorTokenKey(jobId));
    }
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.delete("job");
    nextUrl.hash = "";
    window.history.replaceState(null, "", nextUrl);
    window.localStorage.removeItem(STORED_JOB_KEY);
    setJobId(undefined);
    setJob(undefined);
    setView("home");
    setReport(undefined);
    setError("");
    setHandoffError("");
  }

  async function startIphoneHandoff() {
    if (!jobId || !product) return;
    const operatorToken = window.localStorage.getItem(operatorTokenKey(jobId));
    if (!operatorToken) {
      setError("이 기기에 보안 확인 인계 정보가 없습니다. 같은 iPhone에서 새로 요청해 주세요.");
      return;
    }
    setHandoffStarting(true);
    setHandoffError("");
    try {
      await startMobileHandoff({
        jobId,
        operatorToken,
        url: product.canonicalUrl,
      });
    } catch (caught) {
      setHandoffError(
        caught instanceof Error && caught.message !== "EXTENSION_NOT_AVAILABLE"
          ? caught.message
          : "리뷰모아 Safari 확장을 설치하고 이 웹사이트에 대한 접근을 허용해 주세요.",
      );
    } finally {
      setHandoffStarting(false);
    }
  }

  function showIdeas() {
    window.location.hash = "ideas";
    setView("ideas");
  }

  return (
    <main className={`view-${view}`}>
      <Nav onHome={reset} onIdeas={showIdeas} ideasActive={view === "ideas"} />
      {view === "home" && <Home url={url} setUrl={setUrl} onSubmit={submit} error={error} />}
      {view === "probing" && (
        <Probe
          product={product}
          job={job}
          pollingError={error}
          handoffError={handoffError}
          handoffStarting={handoffStarting}
          onMobileHandoff={startIphoneHandoff}
          onBack={reset}
        />
      )}
      {view === "report" && report && <ReportView report={report} onRefresh={refresh} onBack={reset} />}
      {view === "ideas" && <IdeasPage onBack={reset} />}
      {view === "admin" && <AdminPage onBack={reset} />}
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
          {url && (
            <button
              type="button"
              className="search-clear"
              onClick={() => setUrl("")}
              aria-label="입력 지우기"
            >
              <X size={16} />
            </button>
          )}
          <button type="submit">리뷰 확인 <ArrowRight size={18} /></button>
        </form>
        {error ? <p className="form-error"><AlertTriangle size={14} /> {error}</p> : (
          <p className="search-note">
            <ShieldCheck size={14} />
            <span>중앙 수집 서버가 작업을 처리하며<br />사용자의 개인정보는 수집하지 않습니다.</span>
          </p>
        )}
      </section>
      <section className="sources" aria-label="지원 사이트">
        <p>지원 사이트</p>
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
  return (
    <article>
      <div className="feature-head"><span className="number">{number}</span><h2>{title}</h2></div>
      <p>{children}</p>
    </article>
  );
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

function statusMessage(status: JobStatus, job?: JobSnapshot) {
  if (job?.progress?.message) return job.progress.message;
  const messages: Record<JobStatus, string> = {
    queued: "중앙 수집 서버가 작업을 가져가기를 기다리고 있어요.",
    probing: "상품 페이지와 리뷰 영역을 확인하고 있어요.",
    collecting: job?.progress?.accepted
      ? `정상 리뷰 ${job.progress.accepted}개를 모았어요.`
      : "공개된 최신 리뷰를 별점별로 수집하고 있어요.",
    filtering: "의심 신호와 중복 리뷰를 분리하고 있어요.",
    analyzing: "수집한 리뷰를 바탕으로 구매 인사이트를 만들고 있어요.",
    waiting_for_operator: ["captcha", "login_required", "operator_required"].includes(
      job?.interruptionReason ?? "",
    )
      ? "이 iPhone의 Safari에서 보안 확인을 완료하면 리뷰 수집을 이어갈 수 있어요."
      : "추가 접근 확인이 필요해 작업을 잠시 멈췄어요.",
    waiting_for_login: "운영자 로그인이 필요해 작업을 잠시 멈췄어요.",
    waiting_for_user: "추가 확인이 필요해 작업을 잠시 멈췄어요.",
    completed: "리뷰 보고서가 완성됐어요.",
    partial: "확인할 수 있는 리뷰로 보고서를 준비했어요.",
    failed: "이번에는 리뷰를 안전하게 수집하지 못했어요.",
    cancelled: "작업이 취소됐어요.",
  };
  return messages[status];
}

function statusStep(status: JobStatus) {
  if (["queued"].includes(status)) return 0;
  if ([
    "probing",
    "collecting",
    "filtering",
    "waiting_for_operator",
    "waiting_for_login",
    "waiting_for_user",
  ].includes(status)) return 1;
  return 2;
}

function adminStatusLabel(status: string) {
  return ({
    completed: "완료",
    partial: "부분 완료",
    failed: "실패",
    cancelled: "취소",
    collecting: "수집 중",
    analyzing: "분석 중",
    queued: "대기열",
    waiting_for_login: "로그인 대기",
    waiting_for_user: "사용자 대기",
    waiting_for_operator: "운영자 대기",
  } as Record<string, string>)[status] ?? status;
}

function distributionText(distribution?: Record<string, number>) {
  if (!distribution) return "-";
  return [5, 4, 3, 2, 1]
    .map((rating) => `${rating}점 ${distribution[String(rating)] ?? 0}`)
    .join(" · ");
}

function AdminPage({ onBack }: { onBack: () => void }) {
  const [token, setToken] = useState(() => window.sessionStorage.getItem(ADMIN_TOKEN_KEY) ?? "");
  const [data, setData] = useState<AdminDiagnostics>();
  const [loading, setLoading] = useState(false);
  const [adminError, setAdminError] = useState("");

  async function load(candidate = token, remember = false) {
    if (!candidate.trim()) {
      setAdminError("운영자 토큰을 입력해 주세요.");
      return;
    }
    setLoading(true);
    setAdminError("");
    try {
      const diagnostics = await getAdminDiagnostics(candidate.trim());
      setData(diagnostics);
      if (remember) window.sessionStorage.setItem(ADMIN_TOKEN_KEY, candidate.trim());
    } catch (caught) {
      setAdminError(caught instanceof Error ? caught.message : "진단 정보를 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (token) void load(token);
  // 저장된 세션 토큰은 최초 진입 시 한 번만 확인합니다.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function signOut() {
    window.sessionStorage.removeItem(ADMIN_TOKEN_KEY);
    setToken("");
    setData(undefined);
    setAdminError("");
  }

  return (
    <section className="admin-page">
      <button className="text-button" onClick={onBack}><ArrowLeft size={15} /> 홈으로</button>
      <div className="admin-heading">
        <div>
          <span className="kicker">PRIVATE OPERATIONS</span>
          <h1>수집 상태 진단</h1>
          <p>최근 작업의 상태와 정제된 수집 진단만 표시합니다.</p>
        </div>
        {data && (
          <div className="admin-actions">
            <button onClick={() => void load()} disabled={loading}><RefreshCw size={14} /> 새로고침</button>
            <button onClick={signOut}>로그아웃</button>
          </div>
        )}
      </div>

      {!data && (
        <form className="admin-login" onSubmit={(event) => {
          event.preventDefault();
          void load(token, true);
        }}>
          <label htmlFor="admin-token">운영자 토큰</label>
          <input
            id="admin-token"
            type="password"
            autoComplete="current-password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="Worker에 등록한 ADMIN_TOKEN"
          />
          <button type="submit" disabled={loading}>{loading ? "확인 중…" : "진단 열기"}</button>
          <small>토큰은 현재 Safari 탭의 세션 저장소에만 보관됩니다.</small>
        </form>
      )}

      {adminError && <p className="admin-error"><AlertTriangle size={15} /> {adminError}</p>}

      {data && (
        <>
          <div className="admin-summary" aria-label="작업 요약">
            <AdminSummaryCard label="최근 작업" value={data.summary.total} />
            <AdminSummaryCard label="성공·부분 완료" value={data.summary.successful} />
            <AdminSummaryCard label="실패·취소" value={data.summary.failed} />
            <AdminSummaryCard
              label="종료 작업 성공률"
              value={data.summary.successRate === null ? "-" : `${data.summary.successRate}%`}
            />
          </div>

          <div className="admin-breakdowns">
            <AdminBreakdown title="사이트별" values={data.summary.bySource} />
            <AdminBreakdown title="확장 버전별" values={data.summary.byExtensionVersion} />
            <div className="admin-breakdown">
              <h2>오류 유형</h2>
              {Object.keys(data.summary.byErrorCode).length === 0
                ? <p>기록된 오류가 없습니다.</p>
                : Object.entries(data.summary.byErrorCode).map(([key, count]) => (
                    <div className="admin-breakdown-row" key={key}><span>{key}</span><strong>{count}</strong></div>
                  ))}
            </div>
          </div>

          <div className="admin-jobs-heading">
            <h2>최근 작업</h2>
            <span>{formatDate(data.generatedAt)} 갱신</span>
          </div>
          <div className="admin-job-list">
            {data.jobs.map((job) => <AdminJobCard key={job.id} job={job} />)}
          </div>
        </>
      )}
    </section>
  );
}

function AdminSummaryCard({ label, value }: { label: string; value: string | number }) {
  return <article><span>{label}</span><strong>{value}</strong></article>;
}

function AdminBreakdown({ title, values }: { title: string; values: Record<string, { total: number; successful: number; failed: number }> }) {
  return (
    <div className="admin-breakdown">
      <h2>{title}</h2>
      {Object.keys(values).length === 0
        ? <p>집계할 정보가 없습니다.</p>
        : Object.entries(values).map(([key, metric]) => (
            <div className="admin-breakdown-row" key={key}>
              <span>{key}</span>
              <strong>{metric.successful}/{metric.total}</strong>
              <small>실패 {metric.failed}</small>
            </div>
          ))}
    </div>
  );
}

function AdminJobCard({ job }: { job: AdminDiagnosticJob }) {
  const diagnostics = job.progress?.diagnostics;
  return (
    <article className={`admin-job admin-job-${job.statusGroup}`}>
      <header>
        <div>
          <span className="admin-job-source">{job.product.sourceLabel ?? job.product.source}</span>
          <strong>{job.product.productId}</strong>
        </div>
        <span className="admin-status">{adminStatusLabel(job.status)}</span>
      </header>
      <dl>
        <div><dt>갱신</dt><dd>{formatDate(job.updatedAt)}</dd></div>
        <div><dt>단계</dt><dd>{job.progress?.stage ?? "-"}</dd></div>
        <div><dt>오류</dt><dd>{job.errorCode ?? job.interruptionReason ?? diagnostics?.failure ?? "-"}</dd></div>
        <div><dt>수집기</dt><dd>{job.collector ?? job.handoffSource ?? "-"}</dd></div>
        <div><dt>확장</dt><dd>{job.progress?.extensionVersion ?? "-"}</dd></div>
        <div><dt>재시도</dt><dd>{job.retryable ? "가능" : "불필요"}</dd></div>
      </dl>
      {diagnostics && (
        <details>
          <summary>정제된 수집 진단</summary>
          <div className="admin-diagnostic-grid">
            <span>어댑터 <strong>{diagnostics.adapter ?? "-"}</strong></span>
            <span>페이지 <strong>{diagnostics.pageKind ?? "-"}</strong></span>
            <span>제어 시도 <strong>{diagnostics.attemptCount ?? 0}회</strong></span>
            <span>검증 <strong>{diagnostics.validation?.ok === false ? diagnostics.validation.reason ?? "실패" : "통과"}</strong></span>
          </div>
          <p>원본 분포: {distributionText(diagnostics.sourceDistribution)}</p>
          <p>수집 분포: {distributionText(diagnostics.ratingDistribution)}</p>
        </details>
      )}
    </article>
  );
}

function Probe({
  product,
  job,
  pollingError,
  handoffError,
  handoffStarting,
  onMobileHandoff,
  onBack,
}: {
  product?: ProductIdentity;
  job?: JobSnapshot;
  pollingError: string;
  handoffError: string;
  handoffStarting: boolean;
  onMobileHandoff: () => void;
  onBack: () => void;
}) {
  const status = job?.status ?? "queued";
  const mobileCollecting = job?.progress?.source === "ios-safari";
  const step = statusStep(status);
  const stopped = ["failed", "cancelled"].includes(status);
  const waiting = ["waiting_for_operator", "waiting_for_login", "waiting_for_user"].includes(status);
  const message = pollingError || statusMessage(status, job);
  const items = [
    {
      title: "수집 작업 대기",
      detail: product ? `${product.sourceLabel} · ${product.productId}` : "저장된 작업 정보를 불러오고 있어요.",
    },
    { title: "상품과 리뷰 수집", detail: message },
    { title: "분석과 보고서 준비", detail: "정상 리뷰를 바탕으로 구매 인사이트를 정리합니다." },
  ];
  return (
    <section className="probe-page">
      <button className="text-button probe-back" onClick={onBack}><ArrowLeft size={16} /> 다른 상품 확인</button>
      <div className="probe-kicker">
        {waiting
          ? "OPERATOR CHECK"
          : stopped
            ? "COLLECTION STOPPED"
            : mobileCollecting
              ? "IPHONE COLLECTOR"
              : "CENTRAL COLLECTOR"}
      </div>
      <h1>
        {waiting
          ? <>보안 확인 후<br />이어서 수집할게요.</>
          : stopped
            ? <>리뷰를 안전하게<br />가져오지 못했어요.</>
            : mobileCollecting
              ? <>이 iPhone에서<br />리뷰를 확인하고 있어요.</>
              : <>중앙 수집 서버가<br />리뷰를 확인하고 있어요.</>}
      </h1>
      <p>{message}</p>
      <div className="probe-list">
        {items.map((item, index) => (
          <div
            className={`probe-item ${index < step ? "done" : index === step ? stopped ? "error" : waiting ? "waiting" : "active" : ""}`}
            key={item.title}
          >
            <span>
              {index < step
                ? <Check size={18} />
                : index === step
                  ? stopped
                    ? <AlertTriangle size={17} />
                    : waiting
                      ? <Clock3 size={17} />
                      : <LoaderCircle className="spin" size={18} />
                  : index + 1}
            </span>
            <div><strong>{item.title}</strong><p>{item.detail}</p></div>
          </div>
        ))}
      </div>
      {status === "waiting_for_operator" &&
        ["captcha", "login_required", "access_blocked", "operator_required"].includes(job?.interruptionReason ?? "") && (
          <>
            <button className="probe-retry" onClick={onMobileHandoff} disabled={handoffStarting}>
              {handoffStarting ? "Safari 확장을 여는 중…" : "이 iPhone에서 보안 확인하기"}
            </button>
            {handoffError && (
              <p className="handoff-error"><AlertTriangle size={15} /> {handoffError}</p>
            )}
          </>
        )}
      {stopped && <button className="probe-retry" onClick={onBack}>새 상품 URL로 다시 요청하기</button>}
      <div className="probe-privacy">
        <ShieldCheck size={17} />
        화면을 닫아도 작업 ID를 저장해 두었다가 다음 방문에 상태를 복원합니다.
      </div>
    </section>
  );
}

function ReportView({ report, onRefresh, onBack }: { report: Report; onRefresh: () => void; onBack: () => void }) {
  const [openRating, setOpenRating] = useState<number | null>(null);
  const confidenceLabel = report.confidence >= 80 ? "높음" : report.confidence >= 60 ? "보통" : "낮음";
  const totalIncluded = useMemo(() => report.ratings.reduce((sum, item) => sum + item.included, 0), [report]);
  const anomalyTotal = Object.values(report.anomalyCounts).reduce((sum, count) => sum + count, 0);
  const totalCollected = useMemo(
    () => report.ratings.reduce((sum, item) => sum + item.checked, 0),
    [report],
  );
  // 리뷰가 하나도 수집되지 않은(실제 0건) 상품은 분석·신뢰도·장단점·제외신호가 모두
  // 빈 값이라 오히려 오해를 준다. 빈 상태로 간결히 안내한다.
  const isEmpty = totalCollected === 0;
  const sampleNotice = report.sampleNotice ?? (
    totalIncluded < 50
      ? totalIncluded
        ? `정상 리뷰가 ${totalIncluded}개로 충분하지 않습니다. 아래 내용은 확인된 리뷰만 기준으로 정리했으니 참고용으로 봐 주세요.`
        : "정상 리뷰가 확인되지 않아 충분한 판단 근거가 없습니다. 확인 가능한 정보만 정리했으니 참고용으로 봐 주세요."
      : undefined
  );
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
          <div className="cache-banner-copy">
            <Clock3 size={16} />
            <span><strong>{formatDate(report.collectedAt)}</strong> 기준으로 수집한 결과입니다.</span>
          </div>
          <button onClick={onRefresh}><RefreshCw size={14} /> 다시 불러오기</button>
        </div>
      </header>

      {isEmpty ? (
        <p className="sample-notice empty-notice">
          <span>아직 등록된 리뷰가 없는 상품이에요.<small>수집된 리뷰 0개</small></span>
        </p>
      ) : sampleNotice && (
        <p className="sample-notice">
          <AlertTriangle size={17} />
          <span>{sampleNotice}</span>
        </p>
      )}

      {!isEmpty && (<>
      <section className="verdict-card">
        <div className="verdict-copy">
          <span className="section-label">
            {["openrouter", "openai"].includes(report.analysisProvider ?? "") ? "AI 분석 결과" : "리뷰 분석 결과"}
          </span>
          <div className="analysis-lines">
            <p><strong>좋은 점</strong><span>{analysis.positive}</span></p>
            <p><strong>아쉬운 점</strong><span>{analysis.negative}</span></p>
            <p className="analysis-conclusion"><strong>결론</strong><span>{analysis.conclusion}</span></p>
          </div>
          <p>반복되는 정상 리뷰를 바탕으로 정리했어요.</p>
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
          <span><strong>{report.confidenceBreakdown ? `${report.confidenceBreakdown.completeness}/35` : "35%"}</strong> 별점별 수집 완성도</span>
          <span><strong>{report.confidenceBreakdown ? `${report.confidenceBreakdown.evidence}/25` : "25%"}</strong> 분석 리뷰의 충분성</span>
          <span><strong>{report.confidenceBreakdown ? `${report.confidenceBreakdown.consistency}/20` : "20%"}</strong> 반복 의견의 강도</span>
          <span><strong>{report.confidenceBreakdown ? `${report.confidenceBreakdown.freshness}/10` : "10%"}</strong> 리뷰 최신성</span>
          <span><strong>{report.confidenceBreakdown ? `${report.confidenceBreakdown.health}/10` : "10%"}</strong> 의심 신호를 제외한 데이터 건전성</span>
        </div>
        <p>구매 성공 확률이 아니라, 이번 결론을 뒷받침하는 리뷰 데이터가 얼마나 충분하고 일관적인지를 나타냅니다.</p>
      </details>

      <section className="insight-grid">
        <InsightList title="사도 좋은 이유" items={report.strengths} tone="positive" />
        <InsightList title="구매 전 확인할 점" items={report.cautions} tone="caution" />
      </section>
      </>)}

      <section className="ratings-section">
        <div className="section-heading">
          <div>
            <span className="section-label">별점별 최신 리뷰</span>
            <h2>{isEmpty ? "아직 별점별 리뷰가 없어요." : "평점별 리뷰를 확인하세요."}</h2>
          </div>
          {!isEmpty && <p>의심 리뷰를 제외한 최신 리뷰를 별점별 최대 100개까지 반영합니다.</p>}
        </div>
        {isEmpty ? (
          <div className="rating-list empty">
            {report.ratings.map((item) => (
              <div className="rating-empty-row" key={item.rating}>
                <span className="rating-number">{item.rating}<Star size={16} fill="currentColor" /></span>
                <strong>{item.rating}점 리뷰 0개</strong>
              </div>
            ))}
          </div>
        ) : (
        <div className="rating-list">
          {report.ratings.map((item) => {
            const visibleReviews = item.reviews.slice(0, 10);
            const canOpen = visibleReviews.length > 0;
            return (
              <article className="rating-card" key={item.rating}>
                <button
                  className="rating-summary"
                  disabled={!canOpen}
                  onClick={() => canOpen && setOpenRating(openRating === item.rating ? null : item.rating)}
                >
                  <span className="rating-number">{item.rating}<Star size={16} fill="currentColor" /></span>
                  <span className="rating-copy">
                    <strong>{item.rating}점 리뷰: {(item.sourceCount ?? item.included).toLocaleString()}개</strong>
                    <small>
                      {item.sourceCount !== undefined && `원본 ${item.sourceCount}개 · `}
                      분석 {item.checked}개 · 정상 {item.included}개 · 제외 {item.excluded}개
                    </small>
                  </span>
                  {canOpen && (
                    <span className="review-toggle">
                      {visibleReviews.length}개 리뷰 보기
                      <ChevronDown className={openRating === item.rating ? "rotated" : ""} size={18} />
                    </span>
                  )}
                </button>
                {canOpen && openRating === item.rating && (
                  <div className="review-panel">
                    {visibleReviews.map((review, index) => (
                      <blockquote key={review.id}>
                        <header><span>구매자 {String(index + 1).padStart(2, "0")}</span><time>{review.createdAt ? formatDate(review.createdAt).split(" 오전")[0].split(" 오후")[0] : "작성일 미상"}</time></header>
                        <p>{cleanReviewText(review.content)}</p>
                      </blockquote>
                    ))}
                  </div>
                )}
              </article>
            );
          })}
        </div>
        )}
      </section>

      {!isEmpty && (
      <section className={`anomaly-card${anomalyTotal ? "" : " empty"}`}>
        <div>
          <span className="section-label">제외된 리뷰 신호</span>
          <h2>{anomalyTotal ? "결론에서 덜어낸 리뷰" : "분리된 리뷰 신호가 없어요"}</h2>
          <p>{anomalyTotal
            ? "거짓 리뷰로 단정하지 않고, 분석 신호에서만 분리했습니다."
            : "자동 규칙에서 제외 신호가 발견되지 않았습니다. 0개가 리뷰 진위를 보증한다는 뜻은 아닙니다."}</p>
        </div>
        <div className="anomaly-stats">
          <span><strong>{report.anomalyCounts.sponsored}</strong>광고성 의심</span>
          <span><strong>{report.anomalyCounts.duplicate}</strong>중복</span>
          <span><strong>{report.anomalyCounts.rating_mismatch}</strong>평점 불일치</span>
          <span><strong>{report.anomalyCounts.uncertain}</strong>판단 유보</span>
        </div>
      </section>
      )}

      {!isEmpty && report.limitations.map((limitation) => <p className="limitation" key={limitation}><AlertTriangle size={14} /> {limitation}</p>)}
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
  const mentionedItems = items.filter((item) => item.mentions > 0).slice(0, 3);
  return (
    <article className={`insight-card ${tone}`}>
      <span className="section-label">{title}</span>
      {mentionedItems.length === 0 && (
        <p className="empty-insights">확인된 표본에서 반복되는 의견이 아직 없어요.</p>
      )}
      {mentionedItems.map((item, index) => (
        <div className="insight-row" key={item.label}>
          <span className="rank">0{index + 1}</span>
          <div><strong>{item.label}</strong><small>{item.mentions}개 리뷰에서 언급 · {Math.round(item.ratio * 100)}%</small></div>
          <div className="mini-bar"><span style={{ width: `${Math.min(item.ratio * 230, 100)}%` }} /></div>
        </div>
      ))}
    </article>
  );
}

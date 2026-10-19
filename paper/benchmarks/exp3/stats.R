# 实验 3 主要分析（ANALYSIS_PLAN §2）：负二项广义线性混合模型（glmmTMB，NB2）。
#   Rscript paper/benchmarks/exp3/stats.R <stats.py 输出目录>
# 读 turns.csv（stats.py 导出，已按计划排除基础设施故障与布置无效的回合），写 stats_glmm.json 与 stats_glmm.md。
# 模型：拦截次数 ~ 组别 + 会话序号 + (1|用户) + (1|论文) + (1|任务类型)
# H1 完整系统 vs 无记忆、H2 完整系统 vs 只有预置规则：率比与 95% CI，Holm 校正。
suppressPackageStartupMessages({ library(glmmTMB); library(emmeans); library(jsonlite) })
args <- commandArgs(trailingOnly = TRUE)
dir <- args[1]
d <- read.csv(file.path(dir, "turns.csv"))
d$arm <- factor(d$arm, levels = c("off", "frozen", "utility"))
fit_one <- function(outcome) {
  f <- as.formula(paste(outcome, "~ arm + session + (1|user_key) + (1|topic) + (1|archetype)"))
  m <- glmmTMB(f, data = d, family = nbinom2)
  if (!isTRUE(m$sdr$pdHess)) {
    # 海森矩阵不正定时退回泊松混合模型（论文中报告）
    m <- glmmTMB(f, data = d, family = poisson)
    fam <- "poisson GLMM (fallback)"
  } else fam <- "negative binomial GLMM (NB2)"
  em <- emmeans(m, ~ arm)
  ct <- contrast(em, list(H1_utility_vs_off = c(-1, 0, 1), H2_utility_vs_frozen = c(0, -1, 1), frozen_vs_off = c(-1, 1, 0)), adjust = "none")
  s <- summary(ct, infer = c(TRUE, TRUE), type = "response")
  ci <- confint(ct, type = "response")
  rr <- data.frame(contrast = as.character(s$contrast), rate_ratio = s$ratio, lower = ci$asymp.LCL, upper = ci$asymp.UCL, p = s$p.value)
  h <- rr$contrast %in% c("H1_utility_vs_off", "H2_utility_vs_frozen")
  rr$holm_p <- NA
  rr$holm_p[h] <- p.adjust(rr$p[h], method = "holm")
  vc <- VarCorr(m)$cond
  list(family = fam, n = nrow(d), contrasts = rr, random_sd = lapply(vc, function(x) attr(x, "stddev")))
}
res <- list(primary = fit_one("guard_rejections"), secondary_signals = fit_one("signals"))
write(toJSON(res, auto_unbox = TRUE, digits = 6, pretty = TRUE), file.path(dir, "stats_glmm.json"))
fmt <- function(r) sprintf("| %s | %.2f | %.2f–%.2f | %.4g | %s |", r$contrast, r$rate_ratio, r$lower, r$upper, r$p, ifelse(is.na(r$holm_p), "", sprintf("%.4g", r$holm_p)))
lines <- c("# 实验 3 主要分析（glmmTMB）", "", paste0("主要终点模型：", res$primary$family, "，回合数 ", res$primary$n), "",
           "| 比较 | 率比 | 95% CI | p | Holm p |", "|---|---|---|---|---|",
           sapply(seq_len(nrow(res$primary$contrasts)), function(i) fmt(res$primary$contrasts[i, ])), "",
           paste0("次要终点（全部守卫信号）：", res$secondary_signals$family), "",
           "| 比较 | 率比 | 95% CI | p | Holm p |", "|---|---|---|---|---|",
           sapply(seq_len(nrow(res$secondary_signals$contrasts)), function(i) fmt(res$secondary_signals$contrasts[i, ])))
writeLines(lines, file.path(dir, "stats_glmm.md"))
cat(lines, sep = "\n")

# 第一阶段（1a）主分析（ANALYSIS_PLAN_v2 §2.4）：
#   准确性：压力任务 + 多轮会话的回合，混合效应 logistic：返工 ~ 组别 + 回合类型 + (1|论文) + (1|任务实例)，平台组为参照；
#   费用：全部回合，log(费用) ~ 组别 + 回合类型 + (1|论文) + (1|任务实例)；
#   四个确证检验（准确性 P vs B1 / B2，费用 P vs B1 / B2）一起 Holm 校正。另报敏感性口径与严重返工（次要）。
#   Rscript analyze_p1.R <p1a-turns.csv>
suppressPackageStartupMessages({ library(lme4) })
args <- commandArgs(trailingOnly = TRUE)
d <- read.csv(args[1], stringsAsFactors = FALSE)
d$arm <- relevel(factor(d$arm), ref = "P")
acc <- subset(d, kind %in% c("stress", "session"))

fit_acc <- function(y) {
  f <- as.formula(paste(y, "~ arm + kind + (1|paper) + (1|instance)"))
  m <- glmer(f, data = acc, family = binomial, control = glmerControl(optimizer = "bobyqa", optCtrl = list(maxfun = 2e5)))
  co <- summary(m)$coefficients
  ci <- suppressMessages(confint(m, parm = c("armB1", "armB2"), method = "Wald"))
  list(model = m, or = exp(co[c("armB1", "armB2"), "Estimate"]), lo = exp(ci[, 1]), hi = exp(ci[, 2]), p = co[c("armB1", "armB2"), "Pr(>|z|)"])
}
fit_cost <- function() {
  m <- lmer(log(cost) ~ arm + kind + (1|paper) + (1|instance), data = subset(d, !is.na(cost) & cost > 0))
  co <- summary(m)$coefficients
  se <- co[c("armB1", "armB2"), "Std. Error"]; est <- co[c("armB1", "armB2"), "Estimate"]
  z <- est / se
  # P/B 的几何均值之比 = exp(-系数)
  list(ratio = exp(-est), lo = exp(-est - 1.96 * se), hi = exp(-est + 1.96 * se), p = 2 * pnorm(-abs(z)))
}

cat("== 描述：返工率（压力 / 会话 / 日常）\n")
print(round(100 * tapply(d$rework, list(d$kind, d$arm), mean), 1))
cat("严重返工率\n"); print(round(100 * tapply(d$severe, list(d$kind, d$arm), mean), 1))
cat("敏感性口径返工率\n"); print(round(100 * tapply(d$rework_sens, list(d$kind, d$arm), mean), 1))

a <- fit_acc("rework"); s <- fit_acc("rework_sens"); v <- fit_acc("severe"); c <- fit_cost()
p_raw <- c(acc_B1 = a$p[["armB1"]], acc_B2 = a$p[["armB2"]], cost_B1 = c$p[["armB1"]], cost_B2 = c$p[["armB2"]])
p_holm <- p.adjust(p_raw, method = "holm")

cat("\n== 确证检验（Holm 校正，总 α = 0.05）\n")
cat(sprintf("准确性 B1 vs P：返工比值比 %.2f（95%% CI %.2f–%.2f），p = %.4g，Holm p = %.4g\n", a$or[1], a$lo[1], a$hi[1], p_raw[1], p_holm[1]))
cat(sprintf("准确性 B2 vs P：返工比值比 %.2f（95%% CI %.2f–%.2f），p = %.4g，Holm p = %.4g\n", a$or[2], a$lo[2], a$hi[2], p_raw[2], p_holm[2]))
cat(sprintf("费用 P/B1：几何均值之比 %.2f（95%% CI %.2f–%.2f），p = %.4g，Holm p = %.4g\n", c$ratio[1], c$lo[1], c$hi[1], p_raw[3], p_holm[3]))
cat(sprintf("费用 P/B2：几何均值之比 %.2f（95%% CI %.2f–%.2f），p = %.4g，Holm p = %.4g\n", c$ratio[2], c$lo[2], c$hi[2], p_raw[4], p_holm[4]))
cat("\n== 敏感性（排除「改正的数字」）\n")
cat(sprintf("B1 vs P：OR %.2f（%.2f–%.2f），p = %.4g；B2 vs P：OR %.2f（%.2f–%.2f），p = %.4g\n", s$or[1], s$lo[1], s$hi[1], s$p[1], s$or[2], s$lo[2], s$hi[2], s$p[2]))
cat("\n== 次要：严重返工\n")
cat(sprintf("B1 vs P：OR %.2f（%.2f–%.2f），p = %.4g；B2 vs P：OR %.2f（%.2f–%.2f），p = %.4g\n", v$or[1], v$lo[1], v$hi[1], v$p[1], v$or[2], v$lo[2], v$hi[2], v$p[2]))
cat("\n== 收敛检查\n"); for (m in list(a$model, s$model, v$model)) cat(if (is.null(m@optinfo$conv$lme4$messages)) "ok" else paste(m@optinfo$conv$lme4$messages, collapse = "; "), "\n")
cat("\n== 费用与耗时（描述）\n")
print(aggregate(cbind(cost, ms = ms / 1000) ~ arm + kind, data = d, FUN = function(x) round(median(x), 4)))
cat("合计费用（美元）\n"); print(round(tapply(d$cost, d$arm, sum, na.rm = TRUE), 2))
cat("平台组守卫拦截：", sum(d$guard[d$arm == "P"]), "次，涉及", sum(d$guard[d$arm == "P"] > 0), "个回合\n")

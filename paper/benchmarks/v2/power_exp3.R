# 实验 3 v2 样本量的模拟功效分析（ANALYSIS_PLAN_v2 §3）。
#   Rscript paper/benchmarks/v2/power_exp3.R [每格重复次数，默认 200]
# 参数取自 v1 正式数据（results/exp3/2026-10-19T13-16-33-196Z）：
#   - 无记忆组在“预置规则未覆盖”的任务上每回合 0.113 次拦截；任务类型间差异大（GLMM 随机效应 SD 1.46），用户间几乎无差异（SD ≈ 0）。
# v2 设计只保留未覆盖的任务并加强触发，情景按无记忆组每回合 0.113（不加强）与 0.25（加强）两档模拟。
# 每次模拟按 v2 预设主要分析拟合：拦截次数 ~ 组别 + 会话序号 + (1|用户) + (1|任务类型)，H1、H2 用 Holm 校正。
suppressPackageStartupMessages(library(glmmTMB))

args <- commandArgs(trailingOnly = TRUE)
reps <- if (length(args) >= 1) as.integer(args[1]) else 200
set.seed(20261020)

simulate_once <- function(n_users, sessions, base_rate, rr_frozen, rr_utility_vs_frozen,
                          n_archetypes = 6, tasks_per_session = 9, sd_arch = 1.0, sd_user = 0.2, theta = 1) {
  arch_eff <- rnorm(n_archetypes, 0, sd_arch)
  arch_eff <- arch_eff - log(mean(exp(arch_eff)))  # 保持任务类型平均后的基线率等于 base_rate
  arms <- c("off", "frozen", "utility")
  arm_rr <- c(off = 1, frozen = rr_frozen, utility = rr_frozen * rr_utility_vs_frozen)
  rows <- list()
  for (arm in arms) {
    for (u in seq_len(n_users)) {
      u_eff <- rnorm(1, 0, sd_user)
      for (s in seq_len(sessions)) {
        arch <- sample(rep(seq_len(n_archetypes), length.out = tasks_per_session))
        # 学习只在有记忆的组随会话出现：效应在前 2 个会话逐步达到设定值
        ramp <- if (arm == "off") 1 else min(1, s / 2)
        rr <- 1 + (arm_rr[[arm]] - 1) * ramp
        mu <- base_rate * rr * exp(arch_eff[arch] + u_eff)
        y <- rnbinom(length(mu), mu = mu, size = theta)
        rows[[length(rows) + 1]] <- data.frame(arm = arm, user = paste(arm, u), session = s, archetype = arch, y = y)
      }
    }
  }
  d <- do.call(rbind, rows)
  d$arm <- factor(d$arm, levels = c("off", "frozen", "utility"))
  fit <- tryCatch(
    glmmTMB(y ~ arm + session + (1 | user) + (1 | archetype), family = nbinom2, data = d),
    error = function(e) NULL
  )
  if (is.null(fit)) return(c(h1 = NA, h2 = NA))
  co <- summary(fit)$coefficients$cond
  vc <- vcov(fit)$cond
  p_h1 <- co["armutility", "Pr(>|z|)"]
  est_h2 <- co["armutility", "Estimate"] - co["armfrozen", "Estimate"]
  se_h2 <- sqrt(vc["armutility", "armutility"] + vc["armfrozen", "armfrozen"] - 2 * vc["armutility", "armfrozen"])
  p_h2 <- 2 * pnorm(-abs(est_h2 / se_h2))
  holm <- p.adjust(c(p_h1, p_h2), method = "holm")
  # 单侧方向：只有估计效应 < 1 时才算检出
  c(h1 = holm[1] < 0.05 && co["armutility", "Estimate"] < 0, h2 = holm[2] < 0.05 && est_h2 < 0)
}

# 效应情景：observed = v1 实测（预置 vs 无记忆 0.69，在线学习 vs 预置 0.74）；target = 改进规则生成后希望检出的最小效应（在线学习 vs 预置 0.5）
effects <- list(observed = c(rr_frozen = 0.69, rr_uf = 0.74), target = c(rr_frozen = 0.7, rr_uf = 0.5))
grid <- expand.grid(
  effect = names(effects),
  base_rate = c(0.113, 0.25),
  n_users = c(8, 16, 24),
  sessions = c(5, 8),
  stringsAsFactors = FALSE
)
out <- list()
for (i in seq_len(nrow(grid))) {
  g <- grid[i, ]
  e <- effects[[g$effect]]
  res <- replicate(reps, simulate_once(g$n_users, g$sessions, g$base_rate, rr_frozen = e[["rr_frozen"]], rr_utility_vs_frozen = e[["rr_uf"]]))
  out[[i]] <- data.frame(g, turns_per_arm = g$n_users * g$sessions * 9,
                         power_h1 = mean(res["h1", ], na.rm = TRUE), power_h2 = mean(res["h2", ], na.rm = TRUE),
                         failed_fits = sum(is.na(res["h1", ])))
  cat(sprintf("%s 基线 %.3f 用户 %d 会话 %d → H1 %.2f  H2 %.2f\n", g$effect, g$base_rate, g$n_users, g$sessions, out[[i]]$power_h1, out[[i]]$power_h2))
}
res <- do.call(rbind, out)
dir.create("paper/benchmarks/v2", showWarnings = FALSE)
write.csv(res, "paper/benchmarks/v2/power_exp3.csv", row.names = FALSE)

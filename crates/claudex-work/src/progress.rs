use crate::{events, model::*, outcome};
use anyhow::{Result, bail};
use serde_json::{Value, json};
use uuid::Uuid;

pub fn policy(v: Option<&Value>) -> Result<Value> {
    let v = v.cloned().unwrap_or(json!({}));
    if !v.is_object()
        || v.as_object()
            .unwrap()
            .keys()
            .any(|k| !["timeline", "reports", "blockerNotifications"].contains(&k.as_str()))
        || v.get("timeline")
            .is_some_and(|v| !matches!(v.as_str(), Some("off" | "public")))
        || v.get("reports")
            .is_some_and(|v| !matches!(v.as_str(), Some("off" | "milestones")))
        || v.get("blockerNotifications")
            .is_some_and(|v| !v.is_boolean())
    {
        return Err(error(
            "CLAUDEX_INVALID_OBSERVABILITY",
            "Invalid observability policy.",
        ));
    }
    Ok(
        json!({"timeline":v.get("timeline").cloned().unwrap_or(json!("off")),"reports":v.get("reports").cloned().unwrap_or(json!("off")),"blockerNotifications":v.get("blockerNotifications").cloned().unwrap_or(json!(false))}),
    )
}
fn canonical(v: &Value) -> Value {
    match v {
        Value::Object(o) => {
            let mut keys = o.keys().collect::<Vec<_>>();
            keys.sort();
            let mut result = serde_json::Map::new();
            for k in keys {
                result.insert(k.clone(), canonical(&o[k]));
            }
            Value::Object(result)
        }
        Value::Array(a) => json!(a.iter().map(canonical).collect::<Vec<_>>()),
        _ => v.clone(),
    }
}
pub fn fingerprint(r: &Value) -> String {
    let mut r = r.clone();
    for k in [
        "id",
        "fingerprint",
        "provenance",
        "provider",
        "generation",
        "reportedAt",
    ] {
        r.as_object_mut().unwrap().remove(k);
    }
    hash_value(&canonical(&r))
}
pub fn instruction(
    t: &mut Value,
    from: &str,
    provenance: &str,
    message: &str,
    extra: Value,
) -> Result<String> {
    if array(&t["instructions"]).len() >= 256 {
        bail!("Instruction capacity reached; existing receipts were preserved.");
    }
    let id = Uuid::new_v4().to_string();
    let mut record = json!({"id":id,"state":"queued","requestedGeneration":t["generation"],"provenance":provenance,"from":from,"createdAt":now()});
    record
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().cloned().unwrap_or_default());
    push(&mut t["instructions"], record);
    push(
        &mut t["messages"],
        json!({"from":from,"kind":"message","text":message,"instructionId":id,"at":now()}),
    );
    events::initialize(t);
    events::append(
        t,
        json!({"generation":t["generation"],"source":"broker","kind":"instruction","instructionId":id,"status":"queued"}),
    );
    Ok(id)
}
pub fn record(t: &mut Value, mut report: Value) -> Result<Value> {
    let fp = fingerprint(&report);
    if let Some(prev) = array(&t["reportHistory"]).iter().find(|r| {
        r["generation"] == report["generation"]
            && r.get("fingerprint")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| fingerprint(r))
                == fp
    }) {
        return Ok(json!({"reportId":prev["id"],"reportChanged":false,"blockerChanged":false}));
    }
    if array(&t["reportHistory"]).len() >= 128 {
        return Err(error(
            "CLAUDEX_REPORT_CAPACITY",
            "Report history capacity reached; existing reports were preserved.",
        ));
    }
    report["id"] = json!(Uuid::new_v4());
    report["fingerprint"] = json!(fp);
    push(&mut t["reportHistory"], report.clone());
    events::initialize(t);
    events::append(
        t,
        json!({"generation":report["generation"],"source":"worker-self-report","kind":"report","reportId":report["id"],"phase":report["stage"],"summary":report["summary"],"nextStep":report["next"],"outcome":report["outcome"]}),
    );
    let mut receipt = json!({"reportId":report["id"],"reportChanged":true,"blockerChanged":false});
    if let Some(input) = report.get("blocker") {
        let id = input["id"].as_str().map(str::to_owned).unwrap_or_else(|| {
            hash_value(&json!([
                report["generation"],
                input["question"],
                input["impact"],
                input["needs"]
            ]))[..32]
                .to_owned()
        });
        let mut blockers = array(&t["blockers"]);
        let index = blockers
            .iter()
            .position(|b| b["id"] == id && b["generation"] == report["generation"]);
        let mut changed = false;
        let index = if let Some(i) = index {
            if matches!(
                blockers[i]["state"].as_str(),
                Some("responded" | "resolved")
            ) {
                receipt["blockerId"] = json!(id);
                return Ok(receipt);
            }
            if ["question", "impact", "needs"]
                .iter()
                .any(|k| blockers[i][*k] != input[*k])
            {
                bump(&mut blockers[i]);
                changed = true;
            }
            i
        } else {
            if blockers.len() >= 64 {
                bail!("Blocker capacity reached; existing decisions were preserved.");
            }
            blockers.push(json!({"id":id,"generation":report["generation"],"state":"open","revision":1,"provenance":"worker-self-reported","createdAt":now()}));
            changed = true;
            blockers.len() - 1
        };
        if changed {
            for k in ["question", "impact", "needs"] {
                blockers[index][k] = input[k].clone();
            }
            blockers[index]["updatedAt"] = json!(now());
            events::append(
                t,
                json!({"generation":report["generation"],"source":"worker-self-report","kind":"blocker","blockerId":id,"status":blockers[index]["state"],"question":input["question"],"impact":input["impact"],"requestedAction":input["needs"]}),
            );
        }
        t["blockers"] = json!(blockers);
        receipt["blockerId"] = json!(id);
        receipt["blockerChanged"] = json!(changed);
    }
    Ok(receipt)
}
pub fn consumed(t: &Value, m: &Value, active: &Value) -> bool {
    match m["kind"].as_str() {
        Some("message") => array(&t["instructions"]).iter().any(|r| {
            r["id"] == m["instructionId"]
                && matches!(r["state"].as_str(), Some("accepted" | "rejected"))
        }),
        Some("child-result" | "child-progress") => {
            let key = if m["kind"] == "child-result" {
                "seenChildren"
            } else {
                "seenProgress"
            };
            m["sourceRevision"].as_u64().is_some_and(|r| {
                active[key][m["from"].as_str().unwrap_or("")]
                    .as_u64()
                    .unwrap_or(0)
                    >= r
            })
        }
        _ => true,
    }
}
pub fn check_in(t: &mut Value, p: &Value, apply: bool) -> Result<Value> {
    let limit = p["limit"].as_u64().unwrap_or(8);
    let budget = p["responseBudgetBytes"].as_u64().unwrap_or(192 * 1024);
    if limit == 0 || limit > 16 || budget < 1024 || budget > 192 * 1024 {
        bail!("Invalid check-in count or response byte bound.");
    }
    let mut receipt = json!({"generation":t["generation"],"instructions":[],"childProgress":[],"hasMore":false,"pause":if t["pause"]["generation"]==t["generation"]&&t["pause"]["state"]=="requested"{t["pause"].clone()}else{Value::Null},"newlyDelivered":0,"newlySeenProgress":0});
    let mut records = array(&t["instructions"]);
    let mut delivered = vec![];
    for (index, r) in records.iter_mut().enumerate() {
        if !(r["state"] == "queued"
            || r["state"] == "delivered" && r["generation"] == t["generation"])
        {
            continue;
        }
        let messages = array(&t["messages"])
            .into_iter()
            .filter(|m| m["kind"] == "message" && m["instructionId"] == r["id"])
            .collect::<Vec<_>>();
        if messages.len() != 1 {
            bail!("Instruction context is missing or ambiguous.");
        }
        if receipt["instructions"].as_array().unwrap().len() >= limit as usize {
            receipt["hasMore"] = json!(true);
            break;
        }
        let item = json!({"instructionId":r["id"],"text":messages[0]["text"],"from":r["from"],"provenance":r["provenance"],"generation":t["generation"],"deliveryProvenance":if r["state"]=="queued"{json!("worker-check-in")}else{r.get("deliveryProvenance").cloned().unwrap_or(json!("broker-context"))}});
        let mut proposed = receipt.clone();
        push(&mut proposed["instructions"], item);
        if r["state"] == "queued" {
            proposed["newlyDelivered"] = json!(proposed["newlyDelivered"].as_u64().unwrap() + 1);
        }
        if mcp_bytes(&proposed) > budget as usize {
            receipt["hasMore"] = json!(true);
            break;
        }
        receipt = proposed;
        if r["state"] == "queued" {
            delivered.push(index);
        }
    }
    let start = t["active"]["messageCount"].as_u64().unwrap_or(0) as usize;
    for m in array(&t["messages"])
        .iter()
        .skip(start)
        .filter(|m| m["kind"] == "child-progress" && !consumed(t, m, &t["active"]))
    {
        if receipt["childProgress"].as_array().unwrap().len() >= limit as usize {
            receipt["hasMore"] = json!(true);
            break;
        }
        if !m["sourceRevision"].is_u64() || !m["progressId"].is_string() {
            continue;
        }
        let notification: Value = serde_json::from_str(m["text"].as_str().unwrap_or(""))?;
        let item = json!({"taskId":m["from"],"generation":notification["generation"],"reportId":m["progressId"],"revision":m["sourceRevision"],"nextAction":"read-child-status","provenance":"worker-self-reported"});
        let mut proposed = receipt.clone();
        push(&mut proposed["childProgress"], item);
        proposed["newlySeenProgress"] = json!(proposed["newlySeenProgress"].as_u64().unwrap() + 1);
        if mcp_bytes(&proposed) > budget as usize {
            receipt["hasMore"] = json!(true);
            break;
        }
        receipt = proposed;
    }
    if apply {
        for i in delivered {
            let r = &mut records[i];
            r["state"] = json!("delivered");
            r["generation"] = t["generation"].clone();
            r["deliveredAt"] = json!(now());
            r["deliveryProvenance"] = json!("worker-check-in");
            r["deliveryCount"] = json!(r["deliveryCount"].as_u64().unwrap_or(0) + 1);
            events::append(
                t,
                json!({"generation":t["generation"],"source":"broker","kind":"instruction","instructionId":r["id"],"status":"delivered"}),
            );
        }
        t["instructions"] = json!(records);
        if !receipt["childProgress"].as_array().unwrap().is_empty() {
            if !t["active"]["seenProgress"].is_object() {
                t["active"]["seenProgress"] = json!({});
            }
            for r in receipt["childProgress"].as_array().unwrap() {
                t["active"]["seenProgress"][r["taskId"].as_str().unwrap()] = r["revision"].clone();
            }
        }
    }
    Ok(receipt)
}
pub fn control(
    t: &mut Value,
    p: &Value,
    from: &str,
    self_worker: bool,
    parent_worker: bool,
    children_active: bool,
) -> Result<Value> {
    if p["generation"] != t["generation"] {
        return Err(error(
            "CLAUDEX_STALE_GENERATION",
            "Control generation does not match the current task.",
        ));
    }
    if t["pendingHandoff"].is_object() || t["cancelRequested"] == true {
        bail!("Task is already transferring or cancelling.");
    }
    let action = p["action"].as_str().unwrap_or("");
    if matches!(action, "ack-instruction" | "checkpoint" | "check-in")
        && (!self_worker || t["status"] != "running")
    {
        bail!("Only the active worker may acknowledge its own instruction or checkpoint.");
    }
    if matches!(
        action,
        "respond-blocker" | "request-pause" | "resume" | "review-result"
    ) && self_worker
    {
        bail!("This action requires the parent or external controller.");
    }
    let provenance = if self_worker {
        "worker-self-reported"
    } else if parent_worker {
        "parent-worker-reported"
    } else {
        "controller-reported"
    };
    let mut receipt = json!({});
    match action {
        "check-in" => return check_in(t, p, true),
        "respond-blocker" | "resolve-blocker" => {
            let txt = text(&p["text"], "blocker response", 4096)?;
            let mut blockers = array(&t["blockers"]);
            let b = blockers
                .iter_mut()
                .find(|b| b["id"] == p["blockerId"] && b["generation"] == p["generation"])
                .ok_or_else(|| {
                    error(
                        "CLAUDEX_INVALID_CONTROL",
                        "Blocker does not belong to the exact generation.",
                    )
                })?;
            if b["state"] == "resolved" || action == "respond-blocker" && b["state"] != "open" {
                bail!("Blocker is no longer awaiting this transition.");
            }
            b["state"] = json!(if action == "respond-blocker" {
                "responded"
            } else {
                "resolved"
            });
            bump(b);
            b[if action == "respond-blocker" {
                "response"
            } else {
                "resolution"
            }] =
                json!({"text":txt,"provenance":provenance,"at":now(),"generation":p["generation"]});
            receipt["blockerId"] = b["id"].clone();
            if action == "respond-blocker" {
                receipt["instructionId"] = json!(instruction(
                    t,
                    from,
                    provenance,
                    &format!(
                        "Decision for blocker {} from generation {}: {}",
                        b["id"].as_str().unwrap(),
                        p["generation"],
                        txt
                    ),
                    json!({"blockerId":b["id"]})
                )?);
                if t["status"] == "completed" {
                    t["status"] = json!("ready");
                }
            }
            t["blockers"] = json!(blockers);
        }
        "ack-instruction" => {
            let g = t["generation"].clone();
            let records = t["instructions"]
                .as_array_mut()
                .ok_or_else(|| error("CLAUDEX_INVALID_CONTROL", "No delivered instruction."))?;
            let r = records
                .iter_mut()
                .find(|r| r["id"] == p["instructionId"] && r["generation"] == g)
                .ok_or_else(|| {
                    error(
                        "CLAUDEX_INVALID_CONTROL",
                        "Instruction generation mismatch.",
                    )
                })?;
            if r["state"] != "delivered"
                || !matches!(p["decision"].as_str(), Some("accepted" | "rejected"))
            {
                bail!(
                    "A delivered instruction and explicit accepted/rejected decision are required."
                );
            }
            r["state"] = p["decision"].clone();
            r["acknowledgedAt"] = json!(now());
            r["acknowledgmentProvenance"] = json!("worker-self-reported");
            if let Some(txt) = p.get("text") {
                r["reason"] = txt.clone();
            }
            receipt["instructionId"] = r["id"].clone();
        }
        "request-pause" => {
            if t["status"] != "running"
                || matches!(
                    t["pause"]["state"].as_str(),
                    Some("requested" | "checkpoint" | "paused")
                )
            {
                bail!("Cooperative pause requires a running task without a pending pause.");
            }
            t["pause"] = json!({"state":"requested","generation":t["generation"],"requestedAt":now(),"provenance":provenance});
            if let Some(txt) = p.get("text") {
                t["pause"]["reason"] = txt.clone();
            }
            receipt["nextAction"] = json!("await-checkpoint");
        }
        "checkpoint" => {
            if t["pause"]["state"] != "requested"
                || t["pause"]["generation"] != t["generation"]
                || children_active
            {
                bail!("Checkpoint requires the exact pending pause and no active child work.");
            }
            text(&p["text"], "checkpoint summary", 4096)?;
            t["pause"]["state"] = json!("checkpoint");
            t["pause"]["checkpointAt"] = json!(now());
            t["pause"]["summary"] = p["text"].clone();
            t["pause"]["checkpointProvenance"] = json!("worker-self-reported");
            receipt = json!({"nextAction":"end-turn","finalResponse":"CLAUDEX_PAUSE","instruction":"End this native turn immediately with exactly CLAUDEX_PAUSE. Do not call more tools. Paused status requires successful native completion and process exit."});
        }
        "resume" => {
            if t["status"] != "paused" || t["pause"]["state"] != "paused" {
                bail!("Resume requires a verified paused boundary.");
            }
            t["pause"]["state"] = json!("resumed");
            t["pause"]["resumedAt"] = json!(now());
            t["status"] = json!("ready");
            push(
                &mut t["messages"],
                json!({"kind":"message","from":from,"text":p.get("text").cloned().unwrap_or(json!("Resume the paused work from its saved checkpoint. Do not replay completed actions.")),"at":now()}),
            );
        }
        "review-result" => {
            if t["status"] != "completed"
                || t["result"]["generation"] != t["generation"]
                || !matches!(p["decision"].as_str(), Some("reviewed" | "integrated"))
            {
                bail!(
                    "Result review requires a final result and explicit reviewed/integrated decision."
                );
            }
            t["resultReview"] = json!({"generation":t["generation"],"state":p["decision"],"provenance":provenance,"at":now()});
            if let Some(v) = p.get("text") {
                t["resultReview"]["notes"] = v.clone();
            }
        }
        _ => bail!("Unknown work control action."),
    }
    if matches!(
        action,
        "request-pause" | "checkpoint" | "resume" | "review-result"
    ) {
        events::append(
            t,
            json!({"generation":t["generation"],"source":if self_worker{"worker-self-report"}else{"broker"},"kind":"control","status":action}),
        );
    }
    capacity(t)?;
    Ok(receipt)
}
pub fn presentation(t: &Value) -> Value {
    let reports = array(&t["reportHistory"]);
    let latest = reports.last().cloned().unwrap_or(Value::Null);
    json!({"observability":policy(t.get("observability")).unwrap_or(json!({})),"progress":{"provenance":if reports.is_empty(){"unreported"}else{"worker-self-reported"},"reportCount":reports.len(),"lastReportedAt":latest["reportedAt"],"stage":latest["stage"],"next":latest["next"],"current":latest["generation"]==t["generation"]&&matches!(t["status"].as_str(),Some("running"|"waiting"|"paused"|"completed"))},"blockers":array(&t["blockers"]).into_iter().map(|mut b|{b["current"]=json!(b["generation"]==t["generation"]);b}).collect::<Vec<_>>(),"instructions":array(&t["instructions"]),"pause":t["pause"],"resultReview":t["resultReview"]})
}
pub fn query_reports(t: &Value, p: &Value) -> Result<Value> {
    let generation = p["generation"]
        .as_u64()
        .ok_or_else(|| error("CLAUDEX_INVALID_CONTROL", "Invalid report generation."))?;
    let limit = p["limit"].as_u64().unwrap_or(8);
    if generation > t["generation"].as_u64().unwrap_or(0) || limit == 0 || limit > 16 {
        bail!("Invalid report query.");
    }
    let all = array(&t["reportHistory"]);
    let recent = p["recent"] == true;
    let mut after = 0;
    if let Some(c) = p["cursor"].as_str() {
        let v = events::decode(c)?;
        if c.len() > 512
            || recent
            || v["taskId"] != t["id"]
            || v["generation"] != generation
            || v.as_object().is_none_or(|o| o.len() != 3)
        {
            bail!("Report cursor does not match the query.");
        }
        after = v["after"]
            .as_u64()
            .ok_or_else(|| error("CLAUDEX_INVALID_CURSOR", "Invalid report cursor."))?
            as usize;
        if after > all.len() {
            bail!("Report cursor is ahead of the history.");
        }
    }
    let rows = all
        .into_iter()
        .enumerate()
        .filter(|(i, r)| *i >= after && r["generation"] == generation)
        .collect::<Vec<_>>();
    let page = if recent {
        rows.iter()
            .rev()
            .take(limit as usize)
            .rev()
            .collect::<Vec<_>>()
    } else {
        rows.iter().take(limit as usize).collect::<Vec<_>>()
    };
    Ok(
        json!({"taskId":t["id"],"generation":generation,"reports":page.iter().map(|(_,r)|r.clone()).collect::<Vec<_>>(),"cursor":events::encode(&json!({"taskId":t["id"],"generation":generation,"after":page.last().map(|(i,_)|i+1).unwrap_or(after)})),"hasMore":!recent&&rows.len()>page.len(),"collection":if t.get("reportHistory").is_some()||t.get("workEvents").is_some(){"collected"}else{"not-collected"},"limit":128}),
    )
}
pub fn capacity(t: &Value) -> Result<()> {
    if array(&t["instructions"]).len() > 256
        || array(&t["blockers"]).len() > 64
        || array(&t["reportHistory"]).len() > 128
        || bytes(&json!([
            array(&t["blockers"]),
            array(&t["instructions"]),
            t["pause"],
            t["resultReview"]
        ])) > 192 * 1024
    {
        return Err(error(
            "CLAUDEX_PROGRESS_CAPACITY",
            "Work control record capacity reached; existing decisions and instructions were preserved.",
        ));
    }
    Ok(())
}
pub fn mcp_bytes(v: &Value) -> usize {
    bytes(&json!({"content":[{"type":"text","text":serde_json::to_string(v).unwrap()}]}))
}
pub fn validate(t: &Value) -> Result<()> {
    capacity(t)?;
    policy(t.get("observability"))?;
    for report in array(&t["reportHistory"]) {
        if report["generation"]
            .as_u64()
            .is_none_or(|g| g > t["generation"].as_u64().unwrap_or(0))
            || report["provenance"] != "worker-self-reported"
            || report
                .get("fingerprint")
                .is_some_and(|fp| fp != &fingerprint(&report))
        {
            bail!("Malformed persisted report.");
        }
        let mut content = report.clone();
        for k in [
            "id",
            "fingerprint",
            "generation",
            "provenance",
            "provider",
            "reportedAt",
        ] {
            content.as_object_mut().unwrap().remove(k);
        }
        outcome::validate(&content)?;
    }
    Ok(())
}

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;

use crate::models::{InstanceProfile, InstanceProfileView};
use crate::modules::{self, grok_account, grok_instance};

const DEFAULT_INSTANCE_ID: &str = "__default__";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrokInstanceLaunchInfo {
    pub instance_id: String,
    pub user_data_dir: String,
    pub launch_command: String,
}

struct GrokLaunchContext {
    instance_id: String,
    user_data_dir: String,
    working_dir: Option<String>,
    extra_args: String,
    managed: bool,
}

fn runtime_dir() -> Result<PathBuf, String> {
    let path = modules::account::get_data_dir()?.join("grok_runtime");
    ensure_runtime_dir(&path)?;
    Ok(path)
}

fn ensure_runtime_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(|error| format!("创建 Grok runtime 目录失败: {}", error))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("设置 Grok runtime 目录权限失败: {}", error))?;
    }
    Ok(())
}

fn safe_runtime_id(instance_id: &str) -> Result<&str, String> {
    if instance_id == DEFAULT_INSTANCE_ID
        || (!instance_id.is_empty()
            && instance_id
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_')))
    {
        Ok(instance_id)
    } else {
        Err("Grok 实例 ID 非法".to_string())
    }
}

fn pid_path(instance_id: &str) -> Result<PathBuf, String> {
    Ok(runtime_dir()?.join(format!("{}.pid", safe_runtime_id(instance_id)?)))
}

fn wrapper_path(instance_id: &str) -> Result<PathBuf, String> {
    let extension = if cfg!(target_os = "windows") {
        "ps1"
    } else {
        "sh"
    };
    Ok(runtime_dir()?.join(format!(
        "launch-{}.{}",
        safe_runtime_id(instance_id)?,
        extension
    )))
}

#[cfg(not(target_os = "windows"))]
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

#[cfg(target_os = "macos")]
fn macos_process_marker(instance_id: &str) -> String {
    format!("cockpit-grok-instance:{}", instance_id)
}

#[cfg(target_os = "windows")]
fn powershell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn resolve_context(instance_id: &str) -> Result<GrokLaunchContext, String> {
    if instance_id == DEFAULT_INSTANCE_ID {
        let settings = grok_instance::load_default_settings()?;
        return Ok(GrokLaunchContext {
            instance_id: DEFAULT_INSTANCE_ID.to_string(),
            user_data_dir: grok_instance::get_default_grok_home()?
                .to_string_lossy()
                .to_string(),
            working_dir: settings.working_dir,
            extra_args: settings.extra_args,
            managed: false,
        });
    }
    let instance = grok_instance::load_instance_store()?
        .instances
        .into_iter()
        .find(|instance| instance.id == instance_id)
        .ok_or_else(|| "Grok 实例不存在".to_string())?;
    grok_instance::ensure_managed_instance_path(Path::new(&instance.user_data_dir))?;
    Ok(GrokLaunchContext {
        instance_id: instance.id,
        user_data_dir: instance.user_data_dir,
        working_dir: instance.working_dir,
        extra_args: instance.extra_args,
        managed: true,
    })
}

fn build_wrapper_script(
    context: &GrokLaunchContext,
    binary: &Path,
    pid_file: &Path,
) -> Result<String, String> {
    let args = modules::process::parse_extra_args(&context.extra_args);

    #[cfg(not(target_os = "windows"))]
    {
        let mut lines = vec!["#!/bin/sh".to_string(), "set -eu".to_string()];
        let instance_marker = shell_quote(&context.instance_id);
        // Re-exec before publishing the PID so process inspectors see the marker immediately.
        lines.push(format!(
            "if [ \"${{COCKPIT_GROK_INSTANCE_ID:-}}\" != {} ]; then",
            instance_marker
        ));
        lines.push(format!(
            "  exec env COCKPIT_GROK_INSTANCE_ID={} \"$0\"",
            instance_marker
        ));
        lines.push("fi".to_string());
        if let Some(working_dir) = context
            .working_dir
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            if !Path::new(working_dir).is_dir() {
                return Err(format!("Grok CLI 工作目录不存在: {}", working_dir));
            }
            lines.push(format!("cd -- {}", shell_quote(working_dir)));
        }
        lines.push(format!(
            "pid_file={}",
            shell_quote(&pid_file.to_string_lossy())
        ));
        lines.push("temp_pid=\"${pid_file}.tmp.$$\"".to_string());
        lines.push("printf '%s\\n' \"$$\" > \"$temp_pid\"".to_string());
        lines.push("chmod 600 \"$temp_pid\"".to_string());
        lines.push("mv -f \"$temp_pid\" \"$pid_file\"".to_string());
        #[cfg(target_os = "macos")]
        if context.managed {
            lines.push(format!(
                "export GROK_HOME={}",
                shell_quote(&context.user_data_dir)
            ));
        }
        #[cfg(target_os = "macos")]
        let mut command = format!(
            "exec -a {} ",
            shell_quote(&macos_process_marker(&context.instance_id))
        );
        #[cfg(not(target_os = "macos"))]
        let mut command = {
            let mut command = String::from("exec env ");
            if context.managed {
                command.push_str("GROK_HOME=");
                command.push_str(&shell_quote(&context.user_data_dir));
                command.push(' ');
            }
            command
        };
        command.push_str(&shell_quote(&binary.to_string_lossy()));
        for arg in args {
            command.push(' ');
            command.push_str(&shell_quote(arg.trim()));
        }
        lines.push(command);
        Ok(lines.join("\n") + "\n")
    }

    #[cfg(target_os = "windows")]
    {
        let mut lines = vec!["$ErrorActionPreference = 'Stop'".to_string()];
        if let Some(working_dir) = context
            .working_dir
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            if !Path::new(working_dir).is_dir() {
                return Err(format!("Grok CLI 工作目录不存在: {}", working_dir));
            }
            lines.push(format!(
                "Set-Location -LiteralPath {}",
                powershell_quote(working_dir)
            ));
        }
        lines.push(format!(
            "$env:COCKPIT_GROK_INSTANCE_ID={}",
            powershell_quote(&context.instance_id)
        ));
        lines.push(format!(
            "Set-Content -LiteralPath {} -Value $PID -Encoding ascii",
            powershell_quote(&pid_file.to_string_lossy())
        ));
        if context.managed {
            lines.push(format!(
                "$env:GROK_HOME={}",
                powershell_quote(&context.user_data_dir)
            ));
        }
        let mut command = format!("& {}", powershell_quote(&binary.to_string_lossy()));
        for arg in args {
            command.push(' ');
            command.push_str(&powershell_quote(arg.trim()));
        }
        lines.push("try {".to_string());
        lines.push(format!("  {}", command));
        lines.push("} finally {".to_string());
        lines.push(format!(
            "  Remove-Item -LiteralPath {} -Force -ErrorAction SilentlyContinue",
            powershell_quote(&pid_file.to_string_lossy())
        ));
        lines.push("}".to_string());
        Ok(lines.join("\r\n") + "\r\n")
    }
}

fn write_wrapper_file(
    context: &GrokLaunchContext,
    binary: &Path,
    wrapper: &Path,
    pid_file: &Path,
) -> Result<(), String> {
    let script = build_wrapper_script(context, binary, pid_file)?;
    fs::write(&wrapper, script)
        .map_err(|error| format!("写入 Grok 启动 wrapper 失败: {}", error))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("设置 Grok wrapper 权限失败: {}", error))?;
    }
    Ok(())
}

fn write_wrapper(context: &GrokLaunchContext) -> Result<PathBuf, String> {
    let (binary, _) = super::grok::resolve_grok_cli_path()?;
    let wrapper = wrapper_path(&context.instance_id)?;
    let pid_file = pid_path(&context.instance_id)?;
    write_wrapper_file(context, &binary, &wrapper, &pid_file)?;
    Ok(wrapper)
}

fn build_launch_command(context: &GrokLaunchContext) -> Result<String, String> {
    let wrapper = write_wrapper(context)?;
    #[cfg(target_os = "windows")]
    {
        Ok(format!(
            "& {}",
            powershell_quote(&wrapper.to_string_lossy())
        ))
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(shell_quote(&wrapper.to_string_lossy()))
    }
}

fn process_matches(pid: u32, instance_id: &str) -> bool {
    if !modules::process::is_pid_running(pid) {
        return false;
    }
    #[cfg(target_os = "linux")]
    {
        let environment = fs::read(format!("/proc/{}/environ", pid));
        let Ok(environment) = environment else {
            return false;
        };
        let expected = format!("COCKPIT_GROK_INSTANCE_ID={}", instance_id);
        return environment
            .split(|byte| *byte == 0)
            .any(|entry| entry == expected.as_bytes());
    }
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("ps")
            .args(["-ww", "-p", &pid.to_string(), "-o", "command="])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output();
        let Ok(output) = output else {
            return false;
        };
        if !output.status.success() {
            return false;
        }
        let command = String::from_utf8_lossy(&output.stdout);
        let expected_marker = macos_process_marker(instance_id);
        let trimmed = command.trim_start();
        let marker_matches = trimmed
            .strip_prefix(&expected_marker)
            .map(|suffix| {
                suffix
                    .chars()
                    .next()
                    .map(char::is_whitespace)
                    .unwrap_or(true)
            })
            .unwrap_or(false);
        let wrapper_matches = command.contains(&format!("launch-{}.sh", instance_id));
        return marker_matches || wrapper_matches;
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let script = format!(
            "$p=Get-CimInstance Win32_Process -Filter \"ProcessId = {}\"; if ($p) {{$p.CommandLine}}",
            pid
        );
        let output = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .creation_flags(0x0800_0000)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output();
        let Ok(output) = output else {
            return false;
        };
        let command = String::from_utf8_lossy(&output.stdout).to_ascii_lowercase();
        return command.contains(&format!("launch-{}", instance_id).to_ascii_lowercase());
    }
    #[allow(unreachable_code)]
    false
}

fn runtime_pid(instance_id: &str) -> Option<u32> {
    let path = pid_path(instance_id).ok()?;
    let pid = fs::read_to_string(&path).ok()?.trim().parse::<u32>().ok()?;
    if process_matches(pid, instance_id) {
        Some(pid)
    } else {
        let _ = fs::remove_file(path);
        None
    }
}

fn profile_view(mut profile: InstanceProfile) -> InstanceProfileView {
    let pid = runtime_pid(&profile.id);
    profile.last_pid = pid;
    let initialized = grok_instance::is_profile_initialized(Path::new(&profile.user_data_dir));
    InstanceProfileView::from_profile(profile, pid.is_some(), initialized)
}

fn default_view() -> Result<InstanceProfileView, String> {
    let home = grok_instance::get_default_grok_home()?;
    let settings = grok_instance::load_default_settings()?;
    let pid = runtime_pid(DEFAULT_INSTANCE_ID);
    Ok(InstanceProfileView {
        id: DEFAULT_INSTANCE_ID.to_string(),
        name: String::new(),
        user_data_dir: home.to_string_lossy().to_string(),
        working_dir: settings.working_dir,
        extra_args: settings.extra_args,
        bind_account_id: settings.bind_account_id,
        created_at: 0,
        last_launched_at: None,
        last_pid: pid,
        running: pid.is_some(),
        initialized: grok_instance::is_profile_initialized(&home),
        is_default: true,
        follow_local_account: settings.follow_local_account,
    })
}

async fn prepare_bound_account(instance_id: &str) -> Result<(), String> {
    if instance_id == DEFAULT_INSTANCE_ID {
        let settings = grok_instance::load_default_settings()?;
        let account_id = if settings.follow_local_account {
            grok_account::current_account_id()?
        } else {
            settings.bind_account_id
        };
        if let Some(account_id) = account_id {
            grok_account::prepare_account_for_injection(&account_id).await?;
            grok_account::inject_to_default(&account_id)?;
        }
        return Ok(());
    }

    let instance = grok_instance::load_instance_store()?
        .instances
        .into_iter()
        .find(|instance| instance.id == instance_id)
        .ok_or_else(|| "Grok 实例不存在".to_string())?;
    grok_instance::ensure_managed_instance_path(Path::new(&instance.user_data_dir))?;
    if let Some(account_id) = instance.bind_account_id.as_deref() {
        let account = grok_account::prepare_account_for_injection(account_id).await?;
        grok_account::write_account_to_profile(&account, Path::new(&instance.user_data_dir))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn grok_get_instance_defaults() -> Result<modules::instance::InstanceDefaults, String> {
    grok_instance::get_instance_defaults()
}

#[tauri::command]
pub async fn grok_list_instances() -> Result<Vec<InstanceProfileView>, String> {
    let mut views: Vec<_> = grok_instance::load_instance_store()?
        .instances
        .into_iter()
        .map(profile_view)
        .collect();
    views.push(default_view()?);
    Ok(views)
}

#[tauri::command]
pub async fn grok_create_instance(
    name: String,
    user_data_dir: String,
    working_dir: Option<String>,
    extra_args: Option<String>,
    bind_account_id: Option<String>,
    copy_source_instance_id: Option<String>,
    init_mode: Option<String>,
) -> Result<InstanceProfileView, String> {
    let profile = grok_instance::create_instance(grok_instance::CreateInstanceParams {
        name,
        user_data_dir,
        working_dir,
        extra_args: extra_args.unwrap_or_default(),
        bind_account_id,
        copy_source_instance_id,
        init_mode,
    })?;
    Ok(profile_view(profile))
}

#[tauri::command]
pub async fn grok_update_instance(
    instance_id: String,
    name: Option<String>,
    working_dir: Option<String>,
    extra_args: Option<String>,
    bind_account_id: Option<Option<String>>,
    follow_local_account: Option<bool>,
) -> Result<InstanceProfileView, String> {
    if runtime_pid(&instance_id).is_some() {
        return Err("请先停止 Grok 实例再修改配置".to_string());
    }
    if instance_id == DEFAULT_INSTANCE_ID {
        grok_instance::update_default_settings(
            bind_account_id,
            working_dir,
            extra_args,
            follow_local_account,
        )?;
        return default_view();
    }
    let profile = grok_instance::update_instance(grok_instance::UpdateInstanceParams {
        instance_id,
        name,
        working_dir,
        extra_args,
        bind_account_id,
    })?;
    Ok(profile_view(profile))
}

#[tauri::command]
pub async fn grok_delete_instance(instance_id: String) -> Result<(), String> {
    if instance_id == DEFAULT_INSTANCE_ID {
        return Err("默认 Grok 实例不可删除".to_string());
    }
    if runtime_pid(&instance_id).is_some() {
        return Err("Grok 实例运行中，请先停止后再删除".to_string());
    }
    grok_instance::delete_instance(&instance_id)?;
    let _ = fs::remove_file(wrapper_path(&instance_id)?);
    let _ = fs::remove_file(pid_path(&instance_id)?);
    Ok(())
}

#[tauri::command]
pub async fn grok_start_instance(instance_id: String) -> Result<InstanceProfileView, String> {
    if runtime_pid(&instance_id).is_some() {
        return if instance_id == DEFAULT_INSTANCE_ID {
            default_view()
        } else {
            let profile = grok_instance::load_instance_store()?
                .instances
                .into_iter()
                .find(|profile| profile.id == instance_id)
                .ok_or_else(|| "Grok 实例不存在".to_string())?;
            Ok(profile_view(profile))
        };
    }
    super::grok::resolve_grok_cli_path()?;
    prepare_bound_account(&instance_id).await?;
    if instance_id == DEFAULT_INSTANCE_ID {
        grok_instance::update_default_pid(None)?;
        default_view()
    } else {
        Ok(profile_view(grok_instance::mark_launched(
            &instance_id,
            None,
        )?))
    }
}

#[tauri::command]
pub async fn grok_stop_instance(instance_id: String) -> Result<InstanceProfileView, String> {
    if let Some(pid) = runtime_pid(&instance_id) {
        modules::process::close_pid(pid, 10)?;
    }
    let _ = fs::remove_file(pid_path(&instance_id)?);
    if instance_id == DEFAULT_INSTANCE_ID {
        grok_instance::update_default_pid(None)?;
        default_view()
    } else {
        let profile = grok_instance::update_instance_pid(&instance_id, None)?;
        Ok(profile_view(profile))
    }
}

#[tauri::command]
pub async fn grok_close_all_instances() -> Result<(), String> {
    let ids: Vec<String> = grok_instance::load_instance_store()?
        .instances
        .into_iter()
        .map(|instance| instance.id)
        .chain(std::iter::once(DEFAULT_INSTANCE_ID.to_string()))
        .collect();
    let mut errors = Vec::new();
    for id in ids {
        let stopped = if let Some(pid) = runtime_pid(&id) {
            if let Err(error) = modules::process::close_pid(pid, 10) {
                errors.push(format!("{}: {}", id, error));
                false
            } else {
                true
            }
        } else {
            true
        };
        if stopped {
            if let Ok(path) = pid_path(&id) {
                let _ = fs::remove_file(path);
            }
            if id == DEFAULT_INSTANCE_ID {
                if let Err(error) = grok_instance::update_default_pid(None) {
                    errors.push(format!("{}: {}", id, error));
                }
            } else if let Err(error) = grok_instance::update_instance_pid(&id, None) {
                errors.push(format!("{}: {}", id, error));
            }
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!("部分 Grok 实例未能停止: {}", errors.join("; ")))
    }
}

#[tauri::command]
pub async fn grok_open_instance_window(_instance_id: String) -> Result<(), String> {
    Err("Grok CLI 运行在终端中，请切换到对应终端窗口".to_string())
}

#[tauri::command]
pub async fn grok_get_instance_launch_command(
    instance_id: String,
) -> Result<GrokInstanceLaunchInfo, String> {
    let context = resolve_context(&instance_id)?;
    Ok(GrokInstanceLaunchInfo {
        instance_id,
        user_data_dir: context.user_data_dir.clone(),
        launch_command: build_launch_command(&context)?,
    })
}

#[tauri::command]
pub async fn grok_execute_instance_launch_command(
    instance_id: String,
    terminal: Option<String>,
) -> Result<String, String> {
    if runtime_pid(&instance_id).is_some() {
        return Err("Grok 实例已在运行，请先停止当前终端会话".to_string());
    }
    let context = resolve_context(&instance_id)?;
    let command = build_launch_command(&context)?;
    super::claude::execute_claude_cli_command(&command, terminal)
        .map(|message| message.replace("Claude", "Grok"))
}

#[cfg(test)]
mod tests {
    use super::{
        build_wrapper_script, ensure_runtime_dir, process_matches, write_wrapper_file,
        GrokLaunchContext, DEFAULT_INSTANCE_ID,
    };
    use std::path::{Path, PathBuf};

    fn default_context() -> GrokLaunchContext {
        GrokLaunchContext {
            instance_id: DEFAULT_INSTANCE_ID.to_string(),
            user_data_dir: "/tmp/.grok".to_string(),
            working_dir: None,
            extra_args: String::new(),
            managed: false,
        }
    }

    #[test]
    fn default_wrapper_never_sets_grok_home() {
        let script = build_wrapper_script(
            &default_context(),
            Path::new("/opt/Grok CLI/bin/grok"),
            Path::new("/tmp/grok default.pid"),
        )
        .expect("default wrapper should be generated without a local Grok installation");

        assert!(!script.contains("GROK_HOME"));
        assert!(script.contains("COCKPIT_GROK_INSTANCE_ID"));
    }

    #[test]
    fn managed_wrapper_sets_exactly_one_quoted_grok_home() {
        let context = GrokLaunchContext {
            instance_id: "managed-1".to_string(),
            user_data_dir: "/tmp/Grok Home/team's profile".to_string(),
            working_dir: None,
            extra_args: "--label \"team's files\"".to_string(),
            managed: true,
        };
        let script = build_wrapper_script(
            &context,
            Path::new("/opt/Grok CLI's bin/grok"),
            Path::new("/tmp/Grok Runtime/managed's.pid"),
        )
        .expect("managed wrapper should be generated");

        assert_eq!(script.matches("GROK_HOME").count(), 1);
        #[cfg(not(target_os = "windows"))]
        assert!(script.contains(concat!(
            "if [ \"${COCKPIT_GROK_INSTANCE_ID:-}\" != 'managed-1' ]; then",
            "\n",
            "  exec env COCKPIT_GROK_INSTANCE_ID='managed-1' \"$0\"",
            "\n",
            "fi",
            "\n",
            "pid_file="
        )));
        #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
        assert!(script.contains(concat!(
            "exec env GROK_HOME='/tmp/Grok Home/team'\"'\"'s profile' ",
            "'/opt/Grok CLI'\"'\"'s bin/grok' '--label' 'team'\"'\"'s files'"
        )));
        #[cfg(target_os = "macos")]
        assert!(script.contains(concat!(
            "export GROK_HOME='/tmp/Grok Home/team'\"'\"'s profile'",
            "\n",
            "exec -a 'cockpit-grok-instance:managed-1' ",
            "'/opt/Grok CLI'\"'\"'s bin/grok' '--label' 'team'\"'\"'s files'"
        )));
        #[cfg(target_os = "windows")]
        {
            assert!(script.contains("$env:COCKPIT_GROK_INSTANCE_ID='managed-1'"));
            assert!(script.contains("$env:GROK_HOME='/tmp/Grok Home/team''s profile'"));
        }
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn shell_wrapper_quotes_paths_with_spaces_and_single_quotes() {
        let context = GrokLaunchContext {
            instance_id: "quoted-path".to_string(),
            user_data_dir: "/tmp/managed".to_string(),
            working_dir: None,
            extra_args: String::new(),
            managed: true,
        };
        let script = build_wrapper_script(
            &context,
            Path::new("/tmp/Grok CLI's bin/grok"),
            Path::new("/tmp/Grok Runtime/instance's pid"),
        )
        .expect("wrapper should quote all shell paths");

        assert!(script.contains("pid_file='/tmp/Grok Runtime/instance'\"'\"'s pid'"));
        assert!(script.contains("'/tmp/Grok CLI'\"'\"'s bin/grok'"));
        assert!(script.contains("temp_pid=\"${pid_file}.tmp.$$\""));
    }

    #[cfg(unix)]
    struct TestDir(PathBuf);

    #[cfg(unix)]
    impl TestDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "cockpit-grok-wrapper-test-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&path).expect("create test directory");
            Self(path)
        }
    }

    #[cfg(unix)]
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(unix)]
    #[test]
    fn unix_runtime_wrapper_and_pid_use_restrictive_permissions() {
        use std::os::unix::fs::PermissionsExt;
        use std::process::Command;

        let temp = TestDir::new();
        let runtime = temp.0.join("Grok Runtime's files");
        std::fs::create_dir_all(&runtime).expect("create permissive runtime directory");
        std::fs::set_permissions(&runtime, std::fs::Permissions::from_mode(0o777))
            .expect("set initial runtime permissions");
        ensure_runtime_dir(&runtime).expect("secure runtime directory");
        assert_eq!(
            std::fs::metadata(&runtime)
                .expect("read runtime metadata")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );

        let wrapper = runtime.join("launch managed's profile.sh");
        let pid_file = runtime.join("managed instance's pid");
        let working_dir = temp.0.join("Working Dir's checkout");
        std::fs::create_dir_all(&working_dir).expect("create quoted working directory");
        let binary = ["/usr/bin/true", "/bin/true"]
            .into_iter()
            .map(Path::new)
            .find(|path| path.is_file())
            .expect("a standard true executable is required on Unix");
        let context = GrokLaunchContext {
            instance_id: "managed-permissions".to_string(),
            user_data_dir: temp
                .0
                .join("Managed Grok Home's profile")
                .to_string_lossy()
                .to_string(),
            working_dir: Some(working_dir.to_string_lossy().to_string()),
            extra_args: String::new(),
            managed: true,
        };
        write_wrapper_file(&context, binary, &wrapper, &pid_file)
            .expect("write executable wrapper");
        assert_eq!(
            std::fs::metadata(&wrapper)
                .expect("read wrapper metadata")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );

        let status = Command::new(&wrapper).status().expect("execute wrapper");
        assert!(status.success());
        assert_eq!(
            std::fs::metadata(&pid_file)
                .expect("read pid metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_runtime_pid_requires_exact_wrapper_instance_marker() {
        use std::process::Command;
        use std::time::Duration;

        let temp = TestDir::new();
        let wrapper = temp.0.join("launch-marker-test.sh");
        let pid_file = temp.0.join("marker-test.pid");
        let context = GrokLaunchContext {
            instance_id: "marker-test".to_string(),
            user_data_dir: temp.0.join("home").to_string_lossy().to_string(),
            working_dir: None,
            extra_args: "5".to_string(),
            managed: true,
        };
        write_wrapper_file(&context, Path::new("/bin/sleep"), &wrapper, &pid_file)
            .expect("write marker wrapper");
        let mut child = Command::new(&wrapper)
            .spawn()
            .expect("start marker wrapper");
        let mut pid = None;
        for _ in 0..50 {
            pid = std::fs::read_to_string(&pid_file)
                .ok()
                .and_then(|value| value.trim().parse::<u32>().ok());
            if pid.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let pid = pid.expect("wrapper should persist pid");
        assert!(process_matches(pid, "marker-test"));
        assert!(!process_matches(pid, "other-instance"));
        let _ = child.kill();
        let _ = child.wait();
    }
}

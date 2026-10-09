// The shell navigates here with #error=<message>[&node=missing] when the service cannot start.
const params = new URLSearchParams(location.hash.replace(/^#/, ""));
const error = params.get("error");
if (error) {
  document.getElementById("status").hidden = true;
  document.getElementById("problem").hidden = false;
  document.getElementById("message").textContent = error;
  document.getElementById("node-help").hidden = params.get("node") !== "missing";
}

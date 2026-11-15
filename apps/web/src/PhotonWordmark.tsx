/** Geometric lettering drawn entirely with CSS; the enclosing link supplies its name. */
export function PhotonWordmark() {
  return <span class="photon-wordmark" aria-hidden="true">
    <span class="wordmark-letter wordmark-p"><span class="wordmark-ring"/><span class="wordmark-stem"/></span>
    <span class="wordmark-letter wordmark-h"><span class="wordmark-ring"/><span class="wordmark-stem"/><span class="wordmark-right"/></span>
    <span class="wordmark-letter wordmark-o"><span class="wordmark-ring"/></span>
    <span class="wordmark-letter wordmark-t"><span class="wordmark-ring"/><span class="wordmark-stem"/><span class="wordmark-crossbar"/></span>
    <span class="wordmark-letter wordmark-o wordmark-second-o"><span class="wordmark-ring"/></span>
    <span class="wordmark-letter wordmark-n"><span class="wordmark-ring"/><span class="wordmark-stem"/><span class="wordmark-right"/></span>
  </span>;
}

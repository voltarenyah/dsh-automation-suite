// initialization

const RESPONSIVE_WIDTH = 1024

let headerWhiteBg = false
let isHeaderCollapsed = window.innerWidth < RESPONSIVE_WIDTH
const collapseBtn = document.getElementById("collapse-btn")
const collapseHeaderItems = document.getElementById("collapsed-header-items")

const navToggle = document.querySelector("#nav-dropdown-toggle-0")
const navDropdown = document.querySelector("#nav-dropdown-list-0")


function onHeaderClickOutside(e) {

    if (!collapseHeaderItems.contains(e.target)) {
        toggleHeader()
    }

}


function toggleHeader() {
    if (isHeaderCollapsed) {
        // collapseHeaderItems.classList.remove("max-md:tw-opacity-0")
        collapseHeaderItems.classList.add("max-lg:!tw-opacity-100", "tw-min-h-[90vh]")
        collapseHeaderItems.style.height = "90vh"
        collapseBtn.classList.remove("bi-list")
        collapseBtn.classList.add("bi-x", "max-lg:tw-fixed")
        isHeaderCollapsed = false

        document.body.classList.add("modal-open")

        setTimeout(() => window.addEventListener("click", onHeaderClickOutside), 1)

    } else {
        collapseHeaderItems.classList.remove("max-lg:!tw-opacity-100", "tw-min-h-[90vh]")
        collapseHeaderItems.style.height = "0vh"
        
        collapseBtn.classList.remove("bi-x", "max-lg:tw-fixed")  
        
        collapseBtn.classList.add("bi-list")
        document.body.classList.remove("modal-open")

        isHeaderCollapsed = true
        window.removeEventListener("click", onHeaderClickOutside)

    }
}

function responsive() {
    if (!isHeaderCollapsed){
        toggleHeader()
    }

    if (window.innerWidth > RESPONSIVE_WIDTH) {
        collapseHeaderItems.style.height = ""
        if (navToggle) navToggle.addEventListener("mouseenter", openNavDropdown)
        if (navToggle) navToggle.addEventListener("mouseleave", navMouseLeave)

    } else {
        isHeaderCollapsed = true
        if (navToggle) navToggle.removeEventListener("mouseenter", openNavDropdown)
        if (navToggle) navToggle.removeEventListener("mouseleave", navMouseLeave)
    }
}
responsive()
window.addEventListener("resize", responsive)

/** Dark and light theme */
if (localStorage.getItem('color-mode') === 'dark' || (!('color-mode' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('tw-dark')
    updateToggleModeBtn()
} else {
    document.documentElement.classList.remove('tw-dark')
    updateToggleModeBtn()
}

function toggleMode(){
    //toggle between dark and light mode
    document.documentElement.classList.toggle("tw-dark")
    updateToggleModeBtn()
    
}

function updateToggleModeBtn(){

    const toggleIcon = document.querySelector("#toggle-mode-icon")
    
    if (document.documentElement.classList.contains("tw-dark")){
        // dark mode
        toggleIcon.classList.remove("bi-sun")
        toggleIcon.classList.add("bi-moon")
        localStorage.setItem("color-mode", "dark")
        
    }else{
        toggleIcon.classList.add("bi-sun")
        toggleIcon.classList.remove("bi-moon")
        localStorage.setItem("color-mode", "light")
    }

}


// (the template playground / prompt form was replaced by the capability word wall,
//  so the Prompt + Dropdown wiring is gone with it)


if (navToggle) navToggle.addEventListener("click", toggleNavDropdown)
if (navDropdown) navDropdown.addEventListener("mouseleave", closeNavDropdown)

function toggleNavDropdown(){

    if (navDropdown.getAttribute("data-open") === "true"){
        closeNavDropdown()
    }else{
        openNavDropdown()
    }
}

function navMouseLeave(){
    setTimeout(closeNavDropdown, 100)
}

function openNavDropdown(event){

    navDropdown.classList.add("tw-opacity-100", "tw-scale-100", 
                            "max-lg:tw-min-h-[450px]", "max-lg:!tw-h-fit", "tw-min-w-[320px]")
    
    navDropdown.setAttribute("data-open", true)

}

function closeNavDropdown(event){

    // console.log("event target: ", event.target, event.target.contains(navDropdown))
    
    if (navDropdown.matches(":hover")){
        return
    }

    navDropdown.classList.remove("tw-opacity-100", "tw-scale-100", 
        "max-lg:tw-min-h-[450px]", "tw-min-w-[320px]", "max-lg:!tw-h-fit",)

    navDropdown.setAttribute("data-open", false)

}


const videoBg = document.querySelector("#video-container-bg")
const videoContainer = document.querySelector("#video-container")

function openVideo(){
    videoBg.classList.remove("tw-scale-0", "tw-opacity-0")
    videoBg.classList.add("tw-scale-100", "tw-opacity-100")
    videoContainer.classList.remove("tw-scale-0")
    videoContainer.classList.add("tw-scale-100")

    document.body.classList.add("modal-open")
}

function closeVideo(){
    videoContainer.classList.add("tw-scale-0")
    videoContainer.classList.remove("tw-scale-100")

    setTimeout(() => {
        videoBg.classList.remove("tw-scale-100", "tw-opacity-100")
        videoBg.classList.add("tw-scale-0", "tw-opacity-0")
    }, 400)
   

    document.body.classList.remove("modal-open")

}

/**
 * Animations
 */

gsap.registerPlugin(ScrollTrigger)


gsap.to(".reveal-up", {
    opacity: 0,
    y: "100%",
})


// straightens the slanting image
gsap.to("#dashboard", {

    scale: 1,
    translateY: 0,
    // translateY: "0%",
    rotateX: "0deg",
    scrollTrigger: {
        trigger: "#hero-section",
        start: window.innerWidth > RESPONSIVE_WIDTH ? "top 95%" : "top 70%",
        end: "bottom bottom",
        scrub: 1,
        // markers: true,
    }

})

const faqAccordion = document.querySelectorAll('.faq-accordion')

faqAccordion.forEach(function (btn) {
    btn.addEventListener('click', function () {
        this.classList.toggle('active')

        // Toggle 'rotate' class to rotate the arrow
        let content = this.nextElementSibling
        let icon = this.querySelector(".bi-plus")

        // content.classList.toggle('!tw-hidden')
        if (content.style.maxHeight === '240px') {
            content.style.maxHeight = '0px'
            content.style.padding = '0px 18px'
            icon.style.transform = "rotate(0deg)"
            
        } else {
            content.style.maxHeight = '240px'
            content.style.padding = '20px 18px'
            icon.style.transform = "rotate(45deg)"
        }
    })
})



// ------------- reveal section animations ---------------

const sections = gsap.utils.toArray("section")

sections.forEach((sec) => {

    const revealUptimeline = gsap.timeline({paused: true, 
                                            scrollTrigger: {
                                                            trigger: sec,
                                                            start: "10% 80%", // top of trigger hits the top of viewport
                                                            end: "20% 90%",
                                                            // markers: true,
                                                            // scrub: 1,
                                                        }})

    revealUptimeline.to(sec.querySelectorAll(".reveal-up"), {
        opacity: 1,
        duration: 0.8,
        y: "0%",
        stagger: 0.2,
    })


})


// ------------- capability word wall (hero demo panel) ---------------

// Vocabulary rule: every term must name something a TIA Portal engineer can point
// at inside the software (a block type, a table, a dialog, a device state). Words
// that only make sense as our internal design vocabulary are deliberately absent.
// A trailing "*" marks a roadmap item — rendered with a star, explained by a legend.

const CAPABILITY_TERMS = [
    // --- TIA Portal objects and operations ---
    "TIA Portal V17", "TIA Openness", "Export blocks", "Import blocks", "Compile PLC",
    "Generate source", "External source", "OB · FB · FC · DB", "UDT", "Tag tables",
    "Watch tables", "Force tables", "Project archive", "Project library", "Master copy",
    "Type version", "Software units", "Know-how protection", "Safety signature",
    "Project languages", "Open in block editor", "Save as",

    // --- reading a project ---
    "Call structure", "Cross references", "Variable usage", "Block search",

    // --- versioning ---
    "Version control", "Version history", "Git diff", "Project translation",

    // --- simulation ---
    "PLCSIM Advanced", "Power on / off", "RUN / STOP / reset", "Tag read / write",
    "Snapshot / restore", "Retained data", "Softbus / TCP-IP",

    // --- panels ---
    "PLC blocks panel", "TIA console", "Drawing search",

    // --- roadmap: not shipped yet ---
    "TIA Portal V18*", "Hardware config*", "Online & download*", "Compare blocks*",
    "Project diff*", "Cable & terminals*"
]

// Story-level terms: always rendered large, never dropped by the trimming pass.
const CAPABILITY_ANCHORS = new Set([
    "TIA Portal V17", "TIA Openness", "Export blocks", "Compile PLC",
    "Version control", "PLCSIM Advanced"
])

function mulberry32(a) {
    return function () {
        a |= 0
        a = (a + 0x6d2b79f5) | 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

function initCapabilityWall() {
    const wall = document.getElementById("capability-wall")
    const field = document.getElementById("ww-fields")
    if (!wall || !field) return

    const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    const pool = CAPABILITY_TERMS.slice()

    function build() {
        const width = field.clientWidth
        const height = field.clientHeight
        if (width < 80 || height < 80) return

        const rnd = mulberry32(20261105)
        const narrow = width < 640
        // the vocabulary is deliberately short, so the wall is laid out as a poster:
        // fewer rows, fewer words per row, larger type
        const rows = clamp(Math.round(height / (narrow ? 52 : 76)), 4, 12)
        const perRow = clamp(
            Math.min(Math.ceil(CAPABILITY_TERMS.length / rows), Math.floor(width / (narrow ? 82 : 132))),
            3, 12
        )
        // reserve room for the sideways sway so no row can be clipped at an edge
        const available = width - 32 - (narrow ? 18 : 48)

        // deterministic shuffle so the wall lays out the same on every visit
        for (let i = pool.length - 1; i > 0; i--) {
            const j = Math.floor(rnd() * (i + 1))
            const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp
        }

        // Lay the queue out so the words that carry the story survive when the wall
        // has fewer slots than the vocabulary has terms: anchors and roadmap (starred)
        // terms get reserved, evenly spaced positions; plain terms fill the gaps.
        const anchorTerms = pool.filter(term => CAPABILITY_ANCHORS.has(term))
        const starredTerms = pool.filter(term => term.endsWith("*") && !CAPABILITY_ANCHORS.has(term))
        const plainTerms = pool.filter(term => !CAPABILITY_ANCHORS.has(term) && !term.endsWith("*"))
        const totalSlots = Math.max(rows * perRow, anchorTerms.length + starredTerms.length)
        const reserved = new Map()

        const anchorStep = Math.max(1, Math.floor(totalSlots / Math.max(1, anchorTerms.length)))
        anchorTerms.forEach((term, i) => {
            reserved.set(Math.min(totalSlots - 1, i * anchorStep), term)
        })

        const starStep = Math.max(1, Math.floor(totalSlots / Math.max(1, starredTerms.length)))
        starredTerms.forEach((term, i) => {
            let position = Math.min(totalSlots - 1, Math.floor(i * starStep + starStep / 2))
            while (reserved.has(position) && position < totalSlots - 1) position++
            if (!reserved.has(position)) reserved.set(position, term)
        })

        const ordered = []
        for (let i = 0; i < totalSlots; i++) {
            if (reserved.has(i)) ordered.push(reserved.get(i))
            else if (plainTerms.length) ordered.push(plainTerms.shift())
        }
        pool.splice(0, pool.length, ...ordered)
        let cursor = 0
        const used = new Set()
        const nextTerm = () => {
            for (let guard = 0; guard < pool.length; guard++) {
                if (cursor >= pool.length) cursor = 0
                const term = pool[cursor++]
                if (!used.has(term)) {
                    used.add(term)
                    return term
                }
            }
            return null // vocabulary exhausted — never repeat a term on the wall
        }

        field.replaceChildren()
        const builtRows = []

        for (let r = 0; r < rows; r++) {
            const row = document.createElement("div")
            row.className = "ww-row"
            row.style.setProperty("--x", ((rnd() * 2 - 1) * (narrow ? 4 : 9)).toFixed(1) + "px")
            row.style.setProperty("--dx", ((r % 2 ? 1 : -1) * (4 + rnd() * (narrow ? 4 : 9))).toFixed(1) + "px")
            row.style.setProperty("--drift", ((rnd() * 2 - 1) * 3).toFixed(1) + "px")
            row.style.setProperty("--dur", (11 + rnd() * 8).toFixed(1) + "s")
            row.style.setProperty("--delay", (-rnd() * 10).toFixed(1) + "s")
            for (let c = 0; c < perRow; c++) {
                const term = nextTerm()
                if (!term) break
                const isAnchor = CAPABILITY_ANCHORS.has(term)
                const roll = rnd()
                let size, weight, opacity
                if (isAnchor) {
                    size = (narrow ? 18 : 30) + rnd() * (narrow ? 2 : 4)
                    weight = 500; opacity = 0.93 + rnd() * 0.07
                } else if (roll < 0.04) {
                    size = 21 + rnd() * 3; weight = 500; opacity = 0.7 + rnd() * 0.2
                } else if (roll < 0.3) {
                    size = 16.5 + rnd() * 2.5; weight = 500; opacity = 0.52 + rnd() * 0.26
                } else if (roll < 0.72) {
                    size = 13.5 + rnd() * 2; weight = 400; opacity = 0.4 + rnd() * 0.24
                } else {
                    size = 11.5 + rnd() * 1.5; weight = 400; opacity = 0.3 + rnd() * 0.16
                }

                const word = document.createElement("span")
                word.className = "ww-word"
                if (isAnchor) word.dataset.anchor = "1"
                word.style.setProperty("--fs", (size * (narrow ? 0.88 : 1)).toFixed(1) + "px")
                word.style.setProperty("--fw", weight)
                word.style.setProperty("--o", opacity.toFixed(2))
                word.style.setProperty("--fdur", (4.5 + rnd() * 5.5).toFixed(1) + "s")
                word.style.setProperty("--fdelay", (-rnd() * 7).toFixed(1) + "s")
                word.style.setProperty("--float", (-(1 + rnd() * 4)).toFixed(1) + "px")
                word.style.setProperty("--in-delay", (r * 0.05 + c * 0.014).toFixed(2) + "s")

                const planned = term.endsWith("*")
                const inner = document.createElement("span")
                inner.className = "ww-w"
                inner.textContent = planned ? term.slice(0, -1) : term
                if (planned) {
                    const star = document.createElement("span")
                    star.className = "ww-star"
                    star.textContent = "*"
                    inner.appendChild(star)
                }
                if (!isAnchor && size >= 15 && rnd() < 0.18) inner.classList.add("ww-word--accent")

                word.appendChild(inner)
                row.appendChild(word)
            }

            field.appendChild(row)
            builtRows.push(row)
        }

        // measure shrink-to-fit, then drop the words that would be clipped horizontally
        // (anchor words are trimmed last and shrink instead, so every row fits)
        for (const row of builtRows) {
            row.style.width = "max-content"
            let guard = 0
            while (row.offsetWidth > available && guard++ < 30) {
                const kids = [...row.children]
                const victim = kids.length > 2
                    ? kids.slice().reverse().find(child => !child.dataset.anchor)
                    : null
                if (victim) {
                    victim.remove()
                    continue
                }
                const widest = kids.reduce((a, b) => {
                    const sizeOf = el => parseFloat(el.style.getPropertyValue("--fs")) || 12
                    return sizeOf(b) > sizeOf(a) ? b : a
                })
                const size = parseFloat(widest.style.getPropertyValue("--fs")) || 12
                if (size <= 9) break
                widest.style.setProperty("--fs", (size * 0.85).toFixed(1) + "px")
            }
            row.style.width = ""
        }

        // drop a stub trailing row left behind when the vocabulary runs out
        while (builtRows.length > 4 &&
               builtRows[builtRows.length - 1].children.length < 3 &&
               !builtRows[builtRows.length - 1].querySelector("[data-anchor]")) {
            builtRows.pop().remove()
        }

        if (reduceMotion) {
            field.querySelectorAll(".ww-w").forEach(el => { el.style.animation = "none" })
        }
    }

    let resizeTimer = 0
    build()

    let lastWidth = field.clientWidth
    let lastHeight = field.clientHeight
    window.addEventListener("resize", () => {
        if (Math.abs(field.clientWidth - lastWidth) < 24 &&
            Math.abs(field.clientHeight - lastHeight) < 24) return
        lastWidth = field.clientWidth
        lastHeight = field.clientHeight
        clearTimeout(resizeTimer)
        resizeTimer = setTimeout(build, 160)
    })

    // cursor spotlight
    wall.addEventListener("pointermove", (event) => {
        const rect = wall.getBoundingClientRect()
        wall.style.setProperty("--mx", (((event.clientX - rect.left) / rect.width) * 100).toFixed(2) + "%")
        wall.style.setProperty("--my", (((event.clientY - rect.top) / rect.height) * 100).toFixed(2) + "%")
    }, { passive: true })

    wall.addEventListener("pointerleave", () => {
        wall.style.setProperty("--mx", "50%")
        wall.style.setProperty("--my", "42%")
    })
}

initCapabilityWall()

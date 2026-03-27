"use client";
import React from "react";
import { ContainerScroll } from "@/components/ui/container-scroll-animation";
// Note: In a real app we'd import an actual image or use a placeholder
// Since user said "Fill image assets with Unsplash stock images", I will use direct URLs.

export function HeroScrollDemo() {
    return (
        <div className="flex flex-col overflow-hidden pb-[100px] pt-[50px]">
            <ContainerScroll
                titleComponent={
                    <>
                        <h1 className="text-4xl font-semibold text-white">
                            Sua Escola de Idiomas <br />
                            <span className="text-4xl md:text-[6rem] font-bold mt-1 leading-none bg-clip-text text-transparent bg-gradient-to-b from-purple-400 to-blue-600">
                                10x Mais Rentável
                            </span>
                        </h1>
                    </>
                }
            >
                <img
                    src="https://images.unsplash.com/photo-1551288049-bebda4e38f71?q=80&w=2670&auto=format&fit=crop"
                    alt="hero"
                    className="mx-auto rounded-2xl object-cover h-full object-left-top w-full"
                    draggable={false}
                />
            </ContainerScroll>
        </div>
    );
}
